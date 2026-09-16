import { ExpiringLeaseDto } from '@/modules/leases/dto/expiring-leases-response.dto';

/**
 * The SMS text, in Swahili, addressed to an Owner about one of their tenants.
 *
 * Shaped to one agreed example, which is worth keeping intact when editing:
 *
 *   Habari Yohana Madadi, Mkataba wa James Mchaga, mpangaji wa Old Baruti
 *   Estate - Unit Z1, unamalizika baada ya siku 24, tarehe 10 October 2026.
 *
 * The greeting is the *owner*; the name after "Mkataba wa" is the tenant. Those
 * are different people, which is the whole reason the scan looks recipients up
 * separately rather than texting the number on the lease.
 *
 * A missing owner name degrades to a plain "Habari," rather than printing
 * "Habari null" or refusing to send: the rest of the message is still the
 * information the owner needs.
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

  return (
    `${greeting}, Mkataba wa ${tenant}, ` +
    `mpangaji wa ${lease.unit.propertyName} - Unit ${lease.unit.label}, ` +
    `unamalizika baada ya siku ${lease.daysLeft}, ` +
    `tarehe ${formatDate(lease.endDate, timeZone)}.`
  );
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
