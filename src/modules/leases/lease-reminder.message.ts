import { normalizeTanzanianPhone } from '@/common/phone';
import { ExpiringLeaseDto } from '@/modules/leases/dto/expiring-leases-response.dto';

/**
 * The SMS text, in Swahili, addressed to an Owner about one of their tenants.
 *
 * The greeting is the *owner*; the name after "Mkataba wa" is the tenant. Those
 * are different people, which is the whole reason the scan looks recipients up
 * separately rather than texting the number on the lease.
 *
 * Three shapes, by urgency:
 *
 *   Habari Yohana, Mkataba wa James, mpangaji wa Old Baruti Estate - Unit Z1,
 *   unamalizika baada ya siku 24, tarehe 10 October 2026.
 *
 *   Habari Yohana, Mkataba wa James, mpangaji wa Old Baruti Estate - Unit Z1,
 *   unamalizika kesho, tarehe 20 September 2026. Tafadhali mpigie simu James
 *   kwa namba +255712345678.
 *
 *   Habari Yohana, Mkataba wa James, mpangaji wa Old Baruti Estate - Unit Z1,
 *   unamalizika leo, tarehe 18 September 2026. Tafadhali mpigie simu James
 *   kwa namba +255712345678.
 *
 * The last two exist because "baada ya siku 1" is both clumsy and vague where
 * "kesho" is neither, and because a day before the end is the point at which
 * the owner has to *do* something — so the message stops reporting and starts
 * asking, with the number to call in it. `daysLeft` counts calendar days (see
 * `leases.service.ts`), which is what lets 1 be read as "tomorrow" at all.
 *
 * A missing owner name degrades to a plain "Habari," rather than printing
 * "Habari null" or refusing to send: the rest is still what the owner needs.
 */
export function renderLeaseReminderMessage(
  lease: ExpiringLeaseDto,
  recipientName: string | null,
  timeZone: string,
): string {
  const greeting = recipientName?.trim()
    ? `Habari ${recipientName.trim()}`
    : 'Habari';

  const tenant = lease.membership.name?.trim() ?? 'mpangaji';
  const date = formatDate(lease.endDate, timeZone);
  const opening =
    `${greeting}, Mkataba wa ${tenant}, ` +
    `mpangaji wa ${lease.unit.propertyName} - Unit ${lease.unit.label}`;

  if (lease.daysLeft > 1) {
    return `${opening}, unamalizika baada ya siku ${lease.daysLeft}, tarehe ${date}.`;
  }

  // 0 and 1 both mean "act now", and neither reads as a number of days:
  // "baada ya siku 0" is not a sentence anyone would write.
  const when = lease.daysLeft === 1 ? 'kesho' : 'leo';

  return (
    `${opening}, unamalizika ${when}, tarehe ${date}.` +
    callToAction(tenant, lease.membership.phone)
  );
}

/**
 * "Please call X on number Y", or nothing at all.
 *
 * Dropped entirely when the tenant has no reachable number, rather than sending
 * "kwa namba null" or an empty one: an owner told to call a number that is not
 * there learns less than an owner simply told the lease ends tomorrow.
 *
 * The number is normalised to international form for the same reason the SMS
 * recipient's is — jarvis stores whatever was typed — but falls back to the raw
 * value when it cannot be normalised. A number a person can read and interpret
 * beats no number; this one is dialled by a human, not by a provider's API.
 */
function callToAction(tenant: string, phone: string | null): string {
  if (!phone?.trim()) return '';

  const normalized = normalizeTanzanianPhone(phone);
  const dialable = normalized.ok ? `+${normalized.value}` : phone.trim();

  return ` Tafadhali mpigie simu ${tenant} kwa namba ${dialable}.`;
}

/**
 * `10 October 2026` — day, full month name, year.
 *
 * Rendered in the scan's own time zone rather than UTC, because the date a
 * person reads has to be the date in their calendar: jarvis stores end dates at
 * 00:00 UTC, which is 03:00 in Dar es Salaam, and formatting the same instant
 * in a zone behind UTC would name the previous day.
 *
 * `en-GB` for month names in English, matching the agreed example ("October",
 * not "Oktoba") even though the sentence around it is Swahili.
 */
function formatDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}
