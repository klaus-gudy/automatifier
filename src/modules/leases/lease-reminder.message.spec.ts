import type { ExpiringLeaseDto } from '@/modules/leases/dto/expiring-leases-response.dto';
import { renderLeaseReminderMessage } from '@/modules/leases/lease-reminder.message';

describe('renderLeaseReminderMessage', () => {
  const lease: ExpiringLeaseDto = {
    id: 'lease-1',
    organizationId: 'org-1',
    membership: {
      id: 'membership-1',
      name: 'James Mchaga',
      phone: '0712345678',
      role: 'Tenant',
    },
    unit: { id: 'unit-1', label: 'Z1', propertyName: 'Old Baruti Estate' },
    startDate: new Date('2026-08-10T00:00:00Z'),
    endDate: new Date('2026-10-10T00:00:00Z'),
    daysLeft: 24,
    durationMonths: 2,
    monthlyRent: 300000,
    leaseAmount: 600000,
    renewedFromId: null,
  };

  const timeZone = 'Africa/Dar_es_Salaam';

  it('renders the agreed sentence', () => {
    expect(renderLeaseReminderMessage(lease, 'Yohana Madadi', timeZone)).toBe(
      'Habari Yohana Madadi, Mkataba wa James Mchaga, mpangaji wa ' +
        'Old Baruti Estate - Unit Z1, unamalizika baada ya siku 24, ' +
        'tarehe 10 October 2026.',
    );
  });

  it('names the owner in the greeting and the tenant in the body', () => {
    const message = renderLeaseReminderMessage(
      lease,
      'Yohana Madadi',
      timeZone,
    );

    // The two are different people; swapping them would tell an owner their
    // own lease is ending.
    expect(message.startsWith('Habari Yohana Madadi,')).toBe(true);
    expect(message).toContain('Mkataba wa James Mchaga');
  });

  it('formats the end date in the given zone, not UTC', () => {
    // 00:00 UTC is 03:00 in Dar es Salaam — the same day. In a zone behind UTC
    // the same instant is the previous day, which is why the zone is passed in
    // rather than assumed.
    expect(renderLeaseReminderMessage(lease, 'X', timeZone)).toContain(
      'tarehe 10 October 2026',
    );
    expect(
      renderLeaseReminderMessage(lease, 'X', 'America/New_York'),
    ).toContain('tarehe 9 October 2026');
  });

  it('drops the name rather than greeting nobody when the owner is unnamed', () => {
    const message = renderLeaseReminderMessage(lease, null, timeZone);

    expect(message.startsWith('Habari, Mkataba wa James Mchaga')).toBe(true);
    expect(message).not.toContain('null');
  });

  it('falls back to a generic word when the tenant has no name', () => {
    const unnamed = {
      ...lease,
      membership: { ...lease.membership, name: null },
    };

    expect(renderLeaseReminderMessage(unnamed, 'Yohana', timeZone)).toContain(
      'Mkataba wa mpangaji,',
    );
  });
});
