import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { normalizeTanzanianPhone } from '@/common/phone';
import leaseConfig from '@/config/lease.config';
import {
  ExpiringLeaseDto,
  LeaseReminderTallyDto,
} from '@/modules/leases/dto/expiring-leases-response.dto';
import { LeaseReminder } from '@/modules/leases/lease-reminder.entity';
import { renderLeaseReminderMessage } from '@/modules/leases/lease-reminder.message';
import { LeaseRecipient, LeasesService } from '@/modules/leases/leases.service';

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
export class LeaseReminderService {
  private readonly logger = new Logger(LeaseReminderService.name);

  constructor(
    @InjectRepository(LeaseReminder)
    private readonly reminders: Repository<LeaseReminder>,
    private readonly leases: LeasesService,
    @Inject(leaseConfig.KEY)
    private readonly config: ConfigType<typeof leaseConfig>,
  ) {}

  /**
   * Records a reminder for every (lease, period, Owner) not already recorded.
   *
   * The insert carries `ON CONFLICT DO NOTHING` and reports what it actually
   * wrote, which is what makes a second scan in the same day harmless — and is
   * why the next step can publish exactly the rows returned here without
   * asking whether they were sent before. Checking first and inserting second
   * would leave a window where two scans both pass the check.
   */
  async recordFor(leases: ExpiringLeaseDto[]): Promise<LeaseReminderTallyDto> {
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
