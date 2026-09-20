import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DateTime } from 'luxon';

import leaseConfig from '@/config/lease.config';
import type { ExpiringLeaseDto } from '@/modules/leases/dto/expiring-leases-response.dto';
import {
  LEASE_EXPIRY_SCAN_JOB,
  LeaseExpiryScanService,
} from '@/modules/leases/lease-expiry-scan.service';
import type { LeaseReminderService } from '@/modules/leases/lease-reminder.service';
import type { LeasesService } from '@/modules/leases/leases.service';

describe('LeaseExpiryScanService', () => {
  const config: ConfigType<typeof leaseConfig> = {
    expiryDays: [24, 1],
    expiryScanCron: '0 8 * * *',
    expiryScanTimeZone: 'Africa/Dar_es_Salaam',
    renewalScanCron: '30 8 * * *',
    renewalRoutingKey: 'lease.renewal',
    vacatingRoutingKey: 'lease.vacating',
    smsQueue: 'NOTIFIER_SMS_QUEUE',
    smsRoutingKey: 'lease.expiring',
    reminderSweepCron: '*/10 * * * *',
    reminderBatchSize: 50,
    reminderMaxAttempts: 5,
  };

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

  const recorded = { created: 1, duplicates: 0, skipped: 0 };
  const delivery = { published: 1, failed: 0 };
  const tally = { ...recorded, ...delivery };

  let findExpiring: jest.Mock;
  let recordFor: jest.Mock;
  let publishPending: jest.Mock;
  let registry: SchedulerRegistry;
  let service: LeaseExpiryScanService;
  let logError: jest.SpyInstance;

  beforeEach(() => {
    // The scan logs a block per run; keep the test output readable.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    findExpiring = jest.fn().mockResolvedValue([lease]);
    recordFor = jest.fn().mockResolvedValue(recorded);
    publishPending = jest.fn().mockResolvedValue(delivery);
    registry = new SchedulerRegistry();
    service = new LeaseExpiryScanService(
      { findExpiring } as unknown as LeasesService,
      { recordFor, publishPending } as unknown as LeaseReminderService,
      registry,
      config,
    );
    service.onModuleInit();
  });

  afterEach(async () => {
    // A started job's timer would otherwise keep Jest from exiting.
    await registry.getCronJob(LEASE_EXPIRY_SCAN_JOB).stop();
    jest.restoreAllMocks();
  });

  it('schedules the next run at 08:00 Tanzania time, which is 05:00 UTC', () => {
    const next = DateTime.fromJSDate(service.nextScheduledRunAt());

    const inDarEsSalaam = next.setZone('Africa/Dar_es_Salaam');
    expect([inDarEsSalaam.hour, inDarEsSalaam.minute]).toEqual([8, 0]);

    // The same instant from the other side, so a machine running in UTC or
    // EAT cannot make this pass by accident.
    const inUtc = next.setZone('UTC');
    expect([inUtc.hour, inUtc.minute]).toEqual([5, 0]);

    // Daily: never more than a day away.
    expect(next.diffNow('hours').hours).toBeLessThanOrEqual(24);
    expect(next.diffNow('hours').hours).toBeGreaterThan(0);
  });

  it('registers the job so ScheduleModule stops it on shutdown', () => {
    expect(registry.doesExist('cron', LEASE_EXPIRY_SCAN_JOB)).toBe(true);
    expect(registry.getCronJob(LEASE_EXPIRY_SCAN_JOB).isActive).toBe(true);
  });

  it('scans the configured days and returns what it found', async () => {
    const result = await service.scan('manual');

    expect(findExpiring).toHaveBeenCalledWith([24, 1]);
    expect(result).toMatchObject({
      trigger: 'manual',
      windowDays: [24, 1],
      leases: [lease],
      reminders: tally,
    });
    expect(result.nextScheduledRunAt).toEqual(service.nextScheduledRunAt());
  });

  it('records reminders for the leases it found', async () => {
    await service.scan('manual');

    // The scan hands the whole batch over rather than one lease at a time, so
    // the owner lookup behind it happens once per organization, not per lease.
    expect(recordFor).toHaveBeenCalledWith([lease]);
  });

  it('records before it publishes', async () => {
    await service.scan('manual');

    // Order matters: a message published with no row behind it is one nobody
    // can account for, and the sweeper cannot retry what was never written.
    expect(recordFor.mock.invocationCallOrder[0]).toBeLessThan(
      publishPending.mock.invocationCallOrder[0],
    );
  });

  it('logs a failed scheduled scan instead of throwing', async () => {
    findExpiring.mockRejectedValueOnce(new Error('connection terminated'));

    // Fires the real onTick — the path the 08:00 timer takes.
    await expect(
      registry.getCronJob(LEASE_EXPIRY_SCAN_JOB).fireOnTick(),
    ).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining(
        '[LEASE EXPIRY SCAN FAILED] scheduled — connection terminated',
      ),
    );
  });

  it('refuses to boot with a schedule it cannot parse', () => {
    const broken = new LeaseExpiryScanService(
      { findExpiring } as unknown as LeasesService,
      { recordFor, publishPending } as unknown as LeaseReminderService,
      new SchedulerRegistry(),
      { ...config, expiryScanCron: 'every morning' },
    );

    expect(() => broken.onModuleInit()).toThrow();
  });
});
