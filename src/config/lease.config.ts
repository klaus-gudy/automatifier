import { registerAs } from '@nestjs/config';

import { integerListEnv } from '@/config/env';

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
}));
