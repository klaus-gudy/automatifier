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
}));
