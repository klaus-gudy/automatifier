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
import type { LeasesService } from '@/modules/leases/leases.service';

describe('LeaseExpiryScanService', () => {
  const config: ConfigType<typeof leaseConfig> = {
    expiryDays: [24, 1],
    expiryScanCron: '0 8 * * *',
    expiryScanTimeZone: 'Africa/Dar_es_Salaam',
  };

  const lease: ExpiringLeaseDto = {
    id: 'lease-1',
    unitId: 'unit-1',
    membershipId: 'membership-1',
    startDate: new Date('2026-08-10T00:00:00Z'),
    endDate: new Date('2026-10-10T00:00:00Z'),
    daysLeft: 24,
    durationMonths: 2,
    monthlyRent: 300000,
    leaseAmount: 600000,
    renewedFromId: null,
  };

  let findExpiring: jest.Mock;
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
    registry = new SchedulerRegistry();
    service = new LeaseExpiryScanService(
      { findExpiring } as unknown as LeasesService,
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
    });
    expect(result.nextScheduledRunAt).toEqual(service.nextScheduledRunAt());
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
      new SchedulerRegistry(),
      { ...config, expiryScanCron: 'every morning' },
    );

    expect(() => broken.onModuleInit()).toThrow();
  });
});
