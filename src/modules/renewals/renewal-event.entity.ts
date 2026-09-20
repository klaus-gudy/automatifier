import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { AUTOMATIFIER_SCHEMA } from '@/database/schema';
import { OverdueRenewalLeaseDto } from '@/modules/renewals/dto/overdue-renewals-response.dto';

/**
 * Which event a row becomes on the exchange.
 *
 * Stored rather than derived from `autoRenew`, because the flag lives on
 * jarvis's `Unit` and can be switched after the event went out — and the
 * question this table answers is "what did we publish", not "what would we
 * publish now".
 */
/**
 * The message body, as published. Declared rather than left as a loose
 * object, so a change to what consumers receive is a change to a type the
 * compiler checks against the scan.
 */
export interface RenewalEventPayload {
  lease: OverdueRenewalLeaseDto;
}

export const RENEWAL_EVENT_KINDS = ['RENEWAL', 'VACATING'] as const;

export type RenewalEventKind = (typeof RENEWAL_EVENT_KINDS)[number];

/**
 * Where a renewal event is in its life. The same three states as
 * `LeaseReminder`, minus `SKIPPED`: an event has no recipient to be
 * unreachable, so there is nothing to deliberately not send.
 */
export const RENEWAL_EVENT_STATUSES = [
  'PENDING',
  'PUBLISHED',
  'FAILED',
] as const;

export type RenewalEventStatus = (typeof RENEWAL_EVENT_STATUSES)[number];

/**
 * One `lease.renewal` or `lease.vacating` event about one lease — an outbox,
 * exactly like `LeaseReminder`, and here for a different reason.
 *
 * A reminder needs a row because its period passes. A renewal event does not
 * pass: the lease stays `Active` past its end date until somebody acts, so the
 * daily scan would find it again tomorrow, and the day after, and publish it
 * every time. The row is what makes that repetition stop at one — the scan
 * publishes only the rows it actually inserted.
 *
 * Lives in this service's own schema, and holds no foreign key to jarvis's
 * `Lease`, for the reasons given on `LeaseReminder`.
 */
@Entity({ schema: AUTOMATIFIER_SCHEMA, name: 'renewal_event' })
/*
 * One event per lease per kind — enforced by the database, because two scans
 * running at once would both pass a check made in code.
 *
 * `leaseEndDate` is in the key for the same reason it is in the reminder's: a
 * lease whose end date is edited genuinely becomes overdue again, and a key
 * without it would swallow the second event silently.
 *
 * The kind is in the key too, so a unit whose `autoRenew` is switched between
 * scans can produce both a RENEWAL and a VACATING event. That is a real
 * change of intent, not a duplicate — the consumer sees the later one.
 */
@Unique('uq_renewal_event_lease_kind_end_date', [
  'leaseId',
  'kind',
  'leaseEndDate',
])
/** The sweeper's index: it only ever asks for rows still waiting to go out. */
@Index('idx_renewal_event_pending', ['createdAt'], {
  where: `status = 'PENDING'`,
})
export class RenewalEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** jarvis's `Lease.id` — a cuid, and a reference by value only. */
  @Column({ name: 'lease_id', type: 'text' })
  leaseId: string;

  @Column({ name: 'kind', type: 'text' })
  kind: RenewalEventKind;

  /**
   * The lease's end date as it stood when the event was recorded.
   *
   * `timestamptz`, unlike jarvis's zone-less columns: this schema is ours, so
   * a `Date` written here reads back as the same instant with no agreement
   * needed about which zone the stored value meant.
   */
  @Column({ name: 'lease_end_date', type: 'timestamptz' })
  leaseEndDate: Date;

  /** Calendar days past `endDate` when it was recorded — a snapshot. */
  @Column({ name: 'days_overdue', type: 'int' })
  daysOverdue: number;

  /*
   * Snapshots of jarvis's data, not lookups, for the reason given on
   * `LeaseReminder`: re-reading the source later answers a different question.
   */
  @Column({ name: 'organization_id', type: 'text' })
  organizationId: string;

  @Column({ name: 'tenant_membership_id', type: 'text' })
  tenantMembershipId: string;

  @Column({ name: 'tenant_name', type: 'text', nullable: true })
  tenantName: string | null;

  @Column({ name: 'unit_id', type: 'text' })
  unitId: string;

  @Column({ name: 'unit_label', type: 'text' })
  unitLabel: string;

  @Column({ name: 'property_name', type: 'text' })
  propertyName: string;

  /**
   * The message body as it will be published, stored whole.
   *
   * `jsonb`, not a rebuild from the columns above: the payload is this
   * service's contract with its consumers, and it is published from here after
   * a restart, a failure, or a change to how the scan shapes it.
   */
  @Column({ name: 'payload', type: 'jsonb' })
  payload: RenewalEventPayload;

  /** `text` with a check constraint, not a Postgres enum — see `LeaseReminder`. */
  @Column({ name: 'status', type: 'text', default: 'PENDING' })
  status: RenewalEventStatus;

  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  /** When the *broker* confirmed it, not when this service sent it. */
  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
