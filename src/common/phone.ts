/**
 * Tanzanian mobile numbers, normalised to the international form the SMS
 * provider expects.
 *
 * jarvis stores whatever a person typed — `0712345678`, `+255 712 345 678`,
 * `255712345678` — and notifier's `stripPhoneFormatting` only removes spaces,
 * dashes, brackets and a leading `+`. It never turns a leading `0` into `255`,
 * and its validation accepts any 9–15 digits, so `0712345678` sails through and
 * reaches the provider as a number it cannot route. Converting here, before the
 * event is published, is the only place that fixes it for good.
 */

/** `255` plus a 9-digit subscriber number starting `6` or `7`. */
const INTERNATIONAL = /^255[67]\d{8}$/;

export type NormalizedPhone =
  { ok: true; value: string } | { ok: false; reason: string };

export function normalizeTanzanianPhone(
  raw: string | null | undefined,
): NormalizedPhone {
  if (!raw?.trim()) return { ok: false, reason: 'no phone number on record' };

  // Everything that is not a digit goes: `+`, spaces, dashes, brackets.
  const digits = raw.replace(/\D/g, '');

  const candidate = digits.startsWith('255')
    ? digits
    : digits.startsWith('0')
      ? // Local form: the trunk `0` is replaced by the country code, not
        // prefixed with it — `0712…` is `255712…`, never `2550712…`.
        `255${digits.slice(1)}`
      : `255${digits}`;

  if (!INTERNATIONAL.test(candidate)) {
    /*
     * Refused rather than sent hopefully. A number that is merely *plausible*
     * still costs money per message and, worse, may belong to someone else —
     * the landlord of a different property reading about a lease that is not
     * theirs.
     */
    return { ok: false, reason: `not a Tanzanian mobile number: "${raw}"` };
  }

  return { ok: true, value: candidate };
}
