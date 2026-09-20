import { registerAs } from '@nestjs/config';

import { integerListEnv, numberEnv } from '@/config/env';

export default registerAs('lease', () => ({
  /**
   * The days-left counts at which a lease counts as "expiring" — with
   * `LEASE_EXPIRY_DAYS=24,1`, a lease shows up when it has exactly 24 whole
   * days left, and again at exactly 1.
   *
   * Exact counts rather than windows ("24 days or fewer"), because windows
   * nest: every lease with 1 day left also has 24 or fewer, so the 1-day list
   * would be a subset of the 24-day one and each lease would be reported under
   * every period it had already passed. With exact counts a lease is in at
   * most one period at a time, and something run once a day meets each lease
   * once per period.
   *
   * De-duplicated and sorted furthest-first here, so `24,1`, `1,24` and
   * `24,1,24` all mean the same thing and the response order does not depend
   * on how the variable happened to be typed.
   */
  expiryDays: [...new Set(integerListEnv('LEASE_EXPIRY_DAYS', [24, 1]))].sort(
    (a, b) => b - a,
  ),

  /**
   * When the scheduled expiry scan runs, as a cron expression — five fields
   * (`minute hour day month weekday`), or six with seconds first. Daily at
   * 08:00 by default.
   *
   * An expression `cron` cannot parse fails at boot, when the job is
   * registered, rather than on the morning it was meant to run.
   */
  expiryScanCron: process.env.LEASE_EXPIRY_SCAN_CRON?.trim() || '0 8 * * *',

  /**
   * The IANA time zone `expiryScanCron` is read in — not the machine's.
   *
   * Named explicitly because "08:00" otherwise means whatever zone the process
   * happens to run in: this laptop is EAT, a container is usually UTC, and the
   * same expression would scan at 08:00 on one and 11:00 local on the other.
   * `Africa/Dar_es_Salaam` has no daylight saving, so 08:00 there is 05:00 UTC
   * all year.
   */
  expiryScanTimeZone:
    process.env.LEASE_EXPIRY_SCAN_TIMEZONE?.trim() || 'Africa/Dar_es_Salaam',

  /**
   * When the renewals scan runs — `/renewals/auto` and `/renewals/vacate`,
   * one after the other. Read in `expiryScanTimeZone`, so both daily jobs
   * share one clock. 08:30 by default: after the expiry scan rather than on
   * top of it, so the two blocks do not interleave in the log.
   */
  renewalScanCron: process.env.RENEWAL_SCAN_CRON?.trim() || '30 8 * * *',

  /**
   * Routing keys the renewal scan publishes each lease under, on the event
   * exchange: one event per lease whose unit auto-renews, one per lease whose
   * tenant has to vacate. Lower.dotted, like every routing key here.
   */
  renewalRoutingKey:
    process.env.LEASE_RENEWAL_ROUTING_KEY?.trim() || 'lease.renewal',
  vacatingRoutingKey:
    process.env.LEASE_VACATING_ROUTING_KEY?.trim() || 'lease.vacating',

  /**
   * The queue reminders are published to, **owned by this service and consumed
   * by notifier**. It must match notifier's `RABBITMQ_SMS_QUEUE` exactly:
   * notifier only checks the queue exists, so a mismatch is not a second queue,
   * it is `checkQueue` failing against one that was never declared.
   *
   * Caps, naming who consumes — the house convention that tells a queue apart
   * from a routing key at a glance.
   */
  smsQueue: process.env.LEASE_SMS_QUEUE?.trim() || 'NOTIFIER_SMS_QUEUE',

  /** Lower.dotted, naming what happened, as every routing key here does. */
  smsRoutingKey: process.env.LEASE_SMS_ROUTING_KEY?.trim() || 'lease.expiring',

  /**
   * How often stuck reminders are retried.
   *
   * The scan publishes what it records, so this exists for everything that
   * *failed* to publish — a broker that was down at 08:00, a process that died
   * mid-batch. Ten minutes rather than daily, because the whole point of the
   * outbox is that a reminder is not lost until the day it refers to has
   * passed.
   */
  reminderSweepCron:
    process.env.LEASE_REMINDER_SWEEP_CRON?.trim() || '*/10 * * * *',

  /**
   * How many reminders one publish pass claims. Bounds the work a single tick
   * does, so a backlog drains over several passes instead of one long
   * transaction holding rows locked.
   */
  reminderBatchSize: numberEnv('LEASE_REMINDER_BATCH_SIZE', 50),

  /**
   * Publish attempts before a reminder is marked `FAILED` and left alone.
   *
   * Without a ceiling, a reminder that can never be published — a malformed
   * payload the broker rejects, a queue deleted underneath it — is retried
   * every ten minutes forever, and the log that would have told someone is
   * buried under its own repetition.
   */
  reminderMaxAttempts: numberEnv('LEASE_REMINDER_MAX_ATTEMPTS', 5),
}));
