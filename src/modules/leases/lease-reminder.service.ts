import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { normalizeTanzanianPhone } from '@/common/phone';
import leaseConfig from '@/config/lease.config';
import { AUTOMATIFIER_SCHEMA } from '@/database/schema';
import { RabbitmqService } from '@/messaging/rabbitmq.service';
import {
  ExpiringLeaseDto,
  LeaseReminderTallyDto,
} from '@/modules/leases/dto/expiring-leases-response.dto';
import { LeaseReminder } from '@/modules/leases/lease-reminder.entity';
import { renderLeaseReminderMessage } from '@/modules/leases/lease-reminder.message';
import { LeaseRecipient, LeasesService } from '@/modules/leases/leases.service';

/**
 * Names this service in notifier's audit trail, and in its `SendSmsDto`.
 *
 * A constant, not configuration: it is this service's identity, and an
 * environment that could change it would only be able to get it wrong.
 */
const SERVICE_NAME = 'Automatifier';

/**
 * What recording alone can report. Publishing is a separate pass — and a
 * separate pair of counts — because it also covers rows earlier runs left
 * behind, which have nothing to do with what this scan just wrote.
 */
type RecordedTally = Pick<
  LeaseReminderTallyDto,
  'created' | 'duplicates' | 'skipped'
>;

/** The fields a publish pass needs off a claimed row. */
interface ClaimedReminder {
  id: string;
  leaseId: string;
  daysLeft: number;
  recipientPhone: string;
  message: string;
  attempts: number;
}

/** A reminder as it goes into the table, before the database sees it. */
type NewLeaseReminder = Pick<
  LeaseReminder,
  | 'leaseId'
  | 'leaseEndDate'
  | 'daysLeft'
  | 'recipientMembershipId'
  | 'recipientName'
  | 'recipientPhone'
  | 'tenantMembershipId'
  | 'tenantName'
  | 'organizationId'
  | 'unitId'
  | 'unitLabel'
  | 'propertyName'
  | 'message'
  | 'status'
  | 'lastError'
>;

/**
 * Turns the leases a scan found into rows in the outbox — one per Owner of the
 * organization that holds the lease.
 *
 * Writes only. Publishing is a later step, deliberately: getting the rows and
 * the de-duplication right is worth watching on its own before any message
 * reaches a broker, let alone a person's phone.
 */
@Injectable()
export class LeaseReminderService implements OnModuleInit {
  private readonly logger = new Logger(LeaseReminderService.name);

  constructor(
    @InjectRepository(LeaseReminder)
    private readonly reminders: Repository<LeaseReminder>,
    private readonly leases: LeasesService,
    private readonly rabbitmq: RabbitmqService,
    @Inject(leaseConfig.KEY)
    private readonly config: ConfigType<typeof leaseConfig>,
  ) {}

  /**
   * Binds notifier's SMS queue to this service's exchange, at boot rather than
   * at the first publish: a reminder published to an exchange with nothing
   * bound to it is dropped silently, and 08:00 is a bad time to discover that.
   *
   * Bound, not declared. `NOTIFIER_SMS_QUEUE` already exists — jarvis created
   * it against its own `jarvis.sms.dlx`, and re-declaring it here with a
   * different dead-letter exchange is refused outright. One queue, two
   * producers: jarvis's SMS reach it through `jarvis.sms` bound `#`, and these
   * reminders through `automatifier.events` bound `lease.expiring`.
   */
  async onModuleInit(): Promise<void> {
    if (!this.rabbitmq.isEnabled) {
      this.logger.warn(
        'RABBITMQ_ENABLED=false — reminders will be recorded and left ' +
          'PENDING. Nothing is lost; nothing is delivered either.',
      );
      return;
    }

    await this.rabbitmq.bindConsumerQueue({
      queue: this.config.smsQueue,
      routingKeys: [this.config.smsRoutingKey],
    });
  }

  /**
   * Records a reminder for every (lease, period, Owner) not already recorded.
   *
   * The insert carries `ON CONFLICT DO NOTHING` and reports what it actually
   * wrote, which is what makes a second scan in the same day harmless — and is
   * why the next step can publish exactly the rows returned here without
   * asking whether they were sent before. Checking first and inserting second
   * would leave a window where two scans both pass the check.
   */
  async recordFor(leases: ExpiringLeaseDto[]): Promise<RecordedTally> {
    const empty = { created: 0, duplicates: 0, skipped: 0 };
    if (leases.length === 0) return empty;

    const organizationIds = [
      ...new Set(leases.map((lease) => lease.organizationId)),
    ];
    const recipients = await this.leases.findOwnerRecipients(organizationIds);

    const byOrganization = new Map<string, LeaseRecipient[]>();
    for (const recipient of recipients) {
      const existing = byOrganization.get(recipient.organizationId) ?? [];
      existing.push(recipient);
      byOrganization.set(recipient.organizationId, existing);
    }

    const rows: NewLeaseReminder[] = [];

    for (const lease of leases) {
      const owners = byOrganization.get(lease.organizationId) ?? [];

      if (owners.length === 0) {
        /*
         * Nothing to record against: a reminder belongs to a recipient, and an
         * organization with no Owner has nobody to address. Logged rather than
         * stored, because a row keyed on a recipient that does not exist has no
         * key to hold.
         */
        this.logger.warn(
          `lease ${lease.id} expires in ${lease.daysLeft} day(s) but its ` +
            `organization ${lease.organizationId} has no Owner to notify`,
        );
        continue;
      }

      for (const owner of owners) {
        rows.push(this.buildRow(lease, owner));
      }
    }

    if (rows.length === 0) return empty;

    /*
     * `orIgnore()` is `ON CONFLICT DO NOTHING`, and `returning` then lists only
     * the rows that were genuinely inserted — the conflicting ones come back as
     * nothing at all, which is exactly the signal needed.
     */
    const inserted = await this.reminders
      .createQueryBuilder()
      .insert()
      .into(LeaseReminder)
      .values(rows)
      .orIgnore()
      .returning(['id', 'status'])
      .execute();

    const insertedRows = inserted.raw as { id: string; status: string }[];
    const created = insertedRows.filter((row) => row.status !== 'SKIPPED');
    const skipped = insertedRows.filter((row) => row.status === 'SKIPPED');

    return {
      created: created.length,
      skipped: skipped.length,
      // Everything offered and not written was already there.
      duplicates: rows.length - insertedRows.length,
    };
  }

  /**
   * Publishes reminders still waiting, and marks what the broker confirmed.
   *
   * Rows are *claimed* first — one statement that increments `attempts` and
   * returns the rows it touched, under `FOR UPDATE SKIP LOCKED`. That is what
   * lets the scan and the sweeper run at the same moment, or two replicas do,
   * without either sending a text the other already sent: a row locked by one
   * pass is skipped by the other rather than waited for.
   *
   * **At least once, not exactly once.** A process that dies between the
   * broker's confirm and the `PUBLISHED` update leaves a row that will be
   * published again. That is the right way round — a duplicate reminder is an
   * annoyance, a missing one is the failure this table exists to prevent — but
   * it is a real edge, and closing it needs an idempotency key the consumer
   * honours.
   */
  async publishPending(): Promise<{ published: number; failed: number }> {
    if (!this.rabbitmq.isEnabled) return { published: 0, failed: 0 };

    const claimed = await this.claim();
    if (claimed.length === 0) return { published: 0, failed: 0 };

    let published = 0;
    let failed = 0;

    for (const reminder of claimed) {
      /*
       * Belt and braces, and earned: a mis-read query result once produced
       * "reminders" whose every field was `undefined`, and they published
       * cleanly — `JSON.stringify` simply dropped the missing keys, so the
       * broker accepted two messages carrying nothing but a service name.
       * Every message here costs money and reaches a person, so anything that
       * cannot be a reminder is refused rather than sent hopefully.
       */
      if (!reminder?.id || !reminder.recipientPhone || !reminder.message) {
        this.logger.error(
          `refusing to publish a malformed reminder: ${JSON.stringify(reminder)}`,
        );
        failed += 1;
        continue;
      }

      try {
        await this.rabbitmq.publish(this.config.smsRoutingKey, {
          // Exactly notifier's `SendSmsDto`, snake_case and all.
          phone_number: reminder.recipientPhone,
          message: reminder.message,
          service_name: SERVICE_NAME,
          /*
           * Extra fields for tracing a text back to its lease. Safe to add:
           * notifier validates with `whitelist: true`, which strips unknown
           * properties instead of rejecting them, precisely so a producer can
           * grow its payload without breaking the consumer.
           */
          lease_id: reminder.leaseId,
          reminder_id: reminder.id,
        });

        await this.markPublished(reminder.id);
        published += 1;
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        await this.markFailure(reminder, error);
        failed += 1;

        this.logger.error(
          `reminder ${reminder.id} (lease ${reminder.leaseId}, ` +
            `${reminder.daysLeft} day(s) left) failed to publish on attempt ` +
            `${reminder.attempts}: ${error}`,
        );
      }
    }

    this.logger.log(
      `[REMINDERS PUBLISHED] ${published} sent, ${failed} left for the sweeper`,
    );

    return { published, failed };
  }

  /**
   * Takes the next batch of pending reminders, marking the attempt in the same
   * statement that selects them.
   *
   * `SKIP LOCKED` rather than a plain `LIMIT`: two passes running together each
   * get their own rows instead of one blocking on the other's transaction, and
   * neither can hand the same reminder to the broker twice.
   */
  private async claim(): Promise<ClaimedReminder[]> {
    /*
     * **An UPDATE comes back as `[rows, rowCount]`, not as rows.** A SELECT
     * through the same method returns the rows plainly, which is what makes
     * this easy to get wrong — and getting it wrong is not a type error but a
     * loop over two items, the row array and a number, each treated as a
     * reminder. That published two messages whose every field was `undefined`
     * before this destructuring was added.
     */
    const [rows] = await this.reminders.manager.query<
      [ClaimedReminder[], number]
    >(
      `UPDATE "${AUTOMATIFIER_SCHEMA}"."lease_reminder"
          SET attempts = attempts + 1, updated_at = now()
        WHERE id IN (
              SELECT id
                FROM "${AUTOMATIFIER_SCHEMA}"."lease_reminder"
               WHERE status = 'PENDING'
                 AND recipient_phone IS NOT NULL
               ORDER BY created_at
               LIMIT $1
                 FOR UPDATE SKIP LOCKED
        )
      RETURNING id,
                lease_id        AS "leaseId",
                days_left       AS "daysLeft",
                recipient_phone AS "recipientPhone",
                message,
                attempts`,
      [this.config.reminderBatchSize],
    );

    return rows;
  }

  private async markPublished(id: string): Promise<void> {
    await this.reminders.update(id, {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      // Cleared: a row that eventually went out should not still show the
      // reason an earlier attempt didn't.
      lastError: null,
    });
  }

  /**
   * Records why an attempt failed, and gives up once the ceiling is reached.
   *
   * Left `PENDING` until then, which is what puts it back in the sweeper's
   * hands — the row is not lost, it is simply not sent yet.
   */
  private async markFailure(
    reminder: ClaimedReminder,
    error: string,
  ): Promise<void> {
    const exhausted = reminder.attempts >= this.config.reminderMaxAttempts;

    await this.reminders.update(reminder.id, {
      status: exhausted ? 'FAILED' : 'PENDING',
      lastError: error,
    });

    if (exhausted) {
      this.logger.error(
        `reminder ${reminder.id} given up after ` +
          `${reminder.attempts} attempts — marked FAILED, needs a person`,
      );
    }
  }

  private buildRow(
    lease: ExpiringLeaseDto,
    owner: LeaseRecipient,
  ): NewLeaseReminder {
    const phone = normalizeTanzanianPhone(owner.phone);

    const shared = {
      leaseId: lease.id,
      leaseEndDate: lease.endDate,
      daysLeft: lease.daysLeft,
      recipientMembershipId: owner.membershipId,
      recipientName: owner.name,
      tenantMembershipId: lease.membership.id,
      tenantName: lease.membership.name,
      organizationId: lease.organizationId,
      unitId: lease.unit.id,
      unitLabel: lease.unit.label,
      propertyName: lease.unit.propertyName,
      // Rendered either way: a SKIPPED row should still show what would have
      // been sent, so fixing the phone number is all it takes to see the text.
      message: renderLeaseReminderMessage(
        lease,
        owner.name,
        this.config.expiryScanTimeZone,
      ),
    };

    return phone.ok
      ? {
          ...shared,
          recipientPhone: phone.value,
          status: 'PENDING',
          lastError: null,
        }
      : {
          ...shared,
          recipientPhone: null,
          status: 'SKIPPED',
          lastError: phone.reason,
        };
  }
}
