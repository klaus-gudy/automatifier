import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import leaseConfig from '@/config/lease.config';
import { AUTOMATIFIER_SCHEMA } from '@/database/schema';
import { RabbitmqService } from '@/messaging/rabbitmq.service';
import { OverdueRenewalLeaseDto } from '@/modules/renewals/dto/overdue-renewals-response.dto';
import {
  RenewalEvent,
  RenewalEventKind,
  RenewalEventPayload,
} from '@/modules/renewals/renewal-event.entity';

/** What recording alone can report; publishing is a separate pass. */
export interface RecordedEventTally {
  created: number;
  duplicates: number;
}

export interface PublishedEventTally {
  published: number;
  failed: number;
}

/** The fields a publish pass needs off a claimed row. */
interface ClaimedEvent {
  id: string;
  leaseId: string;
  kind: RenewalEventKind;
  payload: RenewalEventPayload;
  attempts: number;
}

/** An event as it goes into the table, before the database sees it. */
type NewRenewalEvent = Pick<
  RenewalEvent,
  | 'leaseId'
  | 'kind'
  | 'leaseEndDate'
  | 'daysOverdue'
  | 'organizationId'
  | 'tenantMembershipId'
  | 'tenantName'
  | 'unitId'
  | 'unitLabel'
  | 'propertyName'
  | 'payload'
>;

/**
 * The outbox behind `lease.renewal` and `lease.vacating`: records the leases a
 * scan found, then publishes what it recorded.
 *
 * Deliberately shaped like `LeaseReminderService`, because it is solving the
 * same problem from the other side. A reminder is recorded so a missed publish
 * is not lost; an event is recorded so a *repeated* one is not sent — the lease
 * stays overdue until somebody acts on it, and without a row every daily scan
 * would publish it again.
 */
@Injectable()
export class RenewalEventService {
  private readonly logger = new Logger(RenewalEventService.name);

  constructor(
    @InjectRepository(RenewalEvent)
    private readonly events: Repository<RenewalEvent>,
    private readonly rabbitmq: RabbitmqService,
    @Inject(leaseConfig.KEY)
    private readonly config: ConfigType<typeof leaseConfig>,
  ) {}

  /** The routing key one kind is published under. */
  routingKeyFor(kind: RenewalEventKind): string {
    return kind === 'RENEWAL'
      ? this.config.renewalRoutingKey
      : this.config.vacatingRoutingKey;
  }

  /**
   * Records one event per lease not already recorded for this kind and end
   * date.
   *
   * `ON CONFLICT DO NOTHING` with `RETURNING`, so what comes back is exactly
   * what was written — the rows a second scan the same day does not produce.
   * Checking first and inserting second would leave a window two concurrent
   * scans both pass through.
   */
  async recordFor(
    kind: RenewalEventKind,
    leases: OverdueRenewalLeaseDto[],
  ): Promise<RecordedEventTally> {
    if (leases.length === 0) return { created: 0, duplicates: 0 };

    const rows = leases.map((lease) => this.buildRow(kind, lease));

    const inserted = await this.events
      .createQueryBuilder()
      .insert()
      .into(RenewalEvent)
      .values(rows)
      .orIgnore()
      .returning(['id'])
      .execute();

    const created = (inserted.raw as { id: string }[]).length;

    return { created, duplicates: rows.length - created };
  }

  /**
   * Publishes events still waiting, and marks what the broker confirmed.
   *
   * Rows are claimed first — one statement incrementing `attempts` under
   * `FOR UPDATE SKIP LOCKED` — so a scan and a sweep running at the same
   * moment, or two replicas, take different rows instead of publishing the
   * same lease twice.
   *
   * **At least once, not exactly once**, like the reminders: a process that
   * dies between the broker's confirm and the `PUBLISHED` update republishes
   * that event on the next pass. Consumers still need to be idempotent on
   * `lease_id`; what this table removes is the *daily* repeat, which no
   * consumer could have told apart from a real second event.
   */
  async publishPending(): Promise<PublishedEventTally> {
    if (!this.rabbitmq.isEnabled) return { published: 0, failed: 0 };

    const claimed = await this.claim();
    if (claimed.length === 0) return { published: 0, failed: 0 };

    let published = 0;
    let failed = 0;

    for (const event of claimed) {
      /*
       * The same guard as the reminders carry, and earned the same way: a
       * mis-read query result once published messages whose every field was
       * `undefined`, because `JSON.stringify` drops missing keys rather than
       * failing.
       */
      if (!event?.id || !event.payload) {
        this.logger.error(
          `refusing to publish a malformed renewal event: ${JSON.stringify(event)}`,
        );
        failed += 1;
        continue;
      }

      try {
        await this.rabbitmq.publish(this.routingKeyFor(event.kind), {
          ...event.payload,
          // Lets a consumer recognise a redelivery of the same event.
          event_id: event.id,
        });

        await this.markPublished(event.id);
        published += 1;
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        await this.markFailure(event, error);
        failed += 1;

        this.logger.error(
          `renewal event ${event.id} (lease ${event.leaseId}, ${event.kind}) ` +
            `failed to publish on attempt ${event.attempts}: ${error}`,
        );
      }
    }

    this.logger.log(
      `[RENEWAL EVENTS PUBLISHED] ${published} sent, ${failed} left for the sweeper`,
    );

    return { published, failed };
  }

  /**
   * Takes the next batch of pending events, marking the attempt in the same
   * statement that selects them.
   *
   * **An UPDATE comes back as `[rows, rowCount]`, not as rows** — the
   * destructuring below is what a SELECT through the same method does not
   * need, and leaving it out is a loop over a row array and a number rather
   * than a type error.
   */
  private async claim(): Promise<ClaimedEvent[]> {
    const [rows] = await this.events.manager.query<[ClaimedEvent[], number]>(
      `UPDATE "${AUTOMATIFIER_SCHEMA}"."renewal_event"
          SET attempts = attempts + 1, updated_at = now()
        WHERE id IN (
              SELECT id
                FROM "${AUTOMATIFIER_SCHEMA}"."renewal_event"
               WHERE status = 'PENDING'
               ORDER BY created_at
               LIMIT $1
                 FOR UPDATE SKIP LOCKED
        )
      RETURNING id,
                lease_id AS "leaseId",
                kind,
                payload,
                attempts`,
      [this.config.reminderBatchSize],
    );

    return rows;
  }

  private async markPublished(id: string): Promise<void> {
    await this.events.update(id, {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      lastError: null,
    });
  }

  /** Left `PENDING` until the attempt ceiling, which is what the sweeper reads. */
  private async markFailure(event: ClaimedEvent, error: string): Promise<void> {
    const exhausted = event.attempts >= this.config.reminderMaxAttempts;

    await this.events.update(event.id, {
      status: exhausted ? 'FAILED' : 'PENDING',
      lastError: error,
    });

    if (exhausted) {
      this.logger.error(
        `renewal event ${event.id} given up after ${event.attempts} ` +
          `attempts — marked FAILED, needs a person`,
      );
    }
  }

  private buildRow(
    kind: RenewalEventKind,
    lease: OverdueRenewalLeaseDto,
  ): NewRenewalEvent {
    return {
      leaseId: lease.id,
      kind,
      leaseEndDate: lease.endDate,
      daysOverdue: lease.daysOverdue,
      organizationId: lease.organizationId,
      tenantMembershipId: lease.membership.id,
      tenantName: lease.membership.name,
      unitId: lease.unit.id,
      unitLabel: lease.unit.label,
      propertyName: lease.unit.propertyName,
      // Stored as it will be sent, so a later publish does not re-derive a
      // payload from jarvis data that has moved on since.
      payload: { lease },
    };
  }
}
