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

/**
 * Where a reminder is in its life.
 *
 * - `PENDING` — recorded, not yet handed to the broker. The sweeper's work list.
 * - `PUBLISHED` — the broker confirmed it. Delivery is the SMS service's problem
 *   from here; this service does not learn the outcome.
 * - `SKIPPED` — deliberately not sent (the owner has no usable phone number). A
 *   row rather than a silence, so "why did nobody get a text" has an answer.
 * - `FAILED` — gave up after repeated publish failures. Needs a person.
 */
export const LEASE_REMINDER_STATUSES = [
  'PENDING',
  'PUBLISHED',
  'SKIPPED',
  'FAILED',
] as const;

export type LeaseReminderStatus = (typeof LEASE_REMINDER_STATUSES)[number];

/**
 * One reminder about one lease, at one of the configured periods, addressed to
 * one Owner.
 *
 * **An outbox, not a log.** The scan matches leases at *exactly* 24 and 1 days
 * left, so a lease that fails to publish at 08:00 is at 23 days tomorrow and
 * matches nothing — without a row here, that reminder is lost silently and
 * forever. The row is written first, published second, and retried from here.
 *
 * It is also the only thing standing between an owner and a duplicate text:
 * nothing downstream de-duplicates (notifier's audit table has no idempotency
 * key), and `POST /leases/expiring/scan` can be called by anyone, any number of
 * times.
 *
 * **One row per recipient**, because an organization can have several Owners
 * and jarvis sends lease notices to all of them. The recipient is therefore
 * part of the identity of a reminder, not a detail of it.
 *
 * Lives in this service's own schema — see `database/schema.ts`. It holds no
 * foreign key to jarvis's `Lease`: that table belongs to another application's
 * migrations, and a cross-schema FK would let this service's rows block
 * jarvis's deletes.
 */
@Entity({ schema: AUTOMATIFIER_SCHEMA, name: 'lease_reminder' })
/*
 * The de-duplication rule, enforced by the database rather than by a check the
 * scan does first — two scans running at once would both pass such a check.
 *
 * `leaseEndDate` is in the key on purpose. A lease whose end date is edited can
 * legitimately reach 24 days left a second time, and a key without it would
 * swallow that reminder without a trace.
 */
@Unique('uq_lease_reminder_lease_period_recipient', [
  'leaseId',
  'daysLeft',
  'leaseEndDate',
  'recipientMembershipId',
])
/** The sweeper's index: it only ever asks for rows still waiting to go out. */
@Index('idx_lease_reminder_pending', ['createdAt'], {
  where: `status = 'PENDING'`,
})
export class LeaseReminder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** jarvis's `Lease.id` — a cuid, and a reference by value only. */
  @Column({ name: 'lease_id', type: 'text' })
  leaseId: string;

  /**
   * The lease's end date as it stood when the reminder was recorded.
   *
   * `timestamptz`, unlike jarvis's zone-less columns: this schema is ours, and
   * storing an absolute instant means a `Date` written here reads back as the
   * same moment without the OID 1114 parser or any other agreement about what
   * zone the value is "really" in.
   */
  @Column({ name: 'lease_end_date', type: 'timestamptz' })
  leaseEndDate: Date;

  /** Which configured period matched — 24 or 1, from `LEASE_EXPIRY_DAYS`. */
  @Column({ name: 'days_left', type: 'int' })
  daysLeft: number;

  /*
   * Who this one is addressed to: an Owner of the organization, not the tenant.
   * The message tells them *about* their tenant.
   */
  @Column({ name: 'recipient_membership_id', type: 'text' })
  recipientMembershipId: string;

  @Column({ name: 'recipient_name', type: 'text', nullable: true })
  recipientName: string | null;

  /**
   * The number as it will be sent — normalised to `255…`, not as jarvis stores
   * it. Null when the owner had none that could be normalised, which is what
   * `SKIPPED` records.
   */
  @Column({ name: 'recipient_phone', type: 'text', nullable: true })
  recipientPhone: string | null;

  /*
   * Snapshots, not lookups. jarvis's data keeps moving — a tenant changes their
   * number, a unit is relabelled, a property is renamed — and an audit trail
   * that re-reads the source later answers "what would we say now", which is
   * not the question.
   */
  @Column({ name: 'tenant_membership_id', type: 'text' })
  tenantMembershipId: string;

  @Column({ name: 'tenant_name', type: 'text', nullable: true })
  tenantName: string | null;

  @Column({ name: 'organization_id', type: 'text' })
  organizationId: string;

  @Column({ name: 'unit_id', type: 'text' })
  unitId: string;

  @Column({ name: 'unit_label', type: 'text' })
  unitLabel: string;

  @Column({ name: 'property_name', type: 'text' })
  propertyName: string;

  /** The rendered text, stored as sent rather than re-rendered on demand. */
  @Column({ name: 'message', type: 'text' })
  message: string;

  /**
   * `text` with a check constraint rather than a Postgres enum (which is what
   * notifier uses): this list will grow as delivery gains steps, and widening a
   * check constraint is one migration, where `ALTER TYPE ... ADD VALUE` cannot
   * be used in the same transaction that references the new value.
   */
  @Column({ name: 'status', type: 'text', default: 'PENDING' })
  status: LeaseReminderStatus;

  /** Publish attempts so far — the sweeper gives up after enough of them. */
  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  /** Why the last attempt failed, or why a `SKIPPED` row was never sent. */
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
