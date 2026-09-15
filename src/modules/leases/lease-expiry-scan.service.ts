import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { SEPARATOR } from '@/common/logging/log-format';
import leaseConfig from '@/config/lease.config';
import {
  LeaseExpiryScanResultDto,
  LeaseExpiryScanTrigger,
} from '@/modules/leases/dto/expiring-leases-response.dto';
import { LeasesService } from '@/modules/leases/leases.service';

export const LEASE_EXPIRY_SCAN_JOB = 'lease-expiry-scan';

/**
 * Finds the leases expiring in the configured periods and logs them — on a
 * schedule, and on demand through `POST /leases/expiring/scan`.
 *
 * Registered through `SchedulerRegistry` in `onModuleInit` rather than with a
 * `@Cron(...)` decorator, because a decorator's arguments are evaluated when
 * the class is *loaded* — before `ConfigModule` has read `.env` — so the
 * schedule could not come from configuration. Registering it in the registry
 * also means `ScheduleModule` stops the job when the app closes; a job kept
 * only in a field here would hold the process open after `app.close()`.
 *
 * **Runs once per process.** Two replicas would each scan at 08:00. Harmless
 * while a scan only logs; once it sends notices, it needs a lock or a single
 * scheduler instance.
 */
@Injectable()
export class LeaseExpiryScanService implements OnModuleInit {
  private readonly logger = new Logger(LeaseExpiryScanService.name);
  private job!: CronJob;

  constructor(
    private readonly leases: LeasesService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(leaseConfig.KEY)
    private readonly config: ConfigType<typeof leaseConfig>,
  ) {}

  onModuleInit(): void {
    const { expiryScanCron: cronTime, expiryScanTimeZone: timeZone } =
      this.config;

    // Throws on an unparseable expression or unknown time zone, which is the
    // point: it stops the boot instead of never firing.
    this.job = CronJob.from({
      cronTime,
      timeZone,
      onTick: () => this.runScheduled(),
      // If a scan ever outlasts the interval (a short test schedule, a slow
      // database), the next tick is skipped rather than run on top of it.
      waitForCompletion: true,
      name: LEASE_EXPIRY_SCAN_JOB,
    });

    this.scheduler.addCronJob(LEASE_EXPIRY_SCAN_JOB, this.job);
    this.job.start();

    this.logger.log(
      `lease expiry scan scheduled "${cronTime}" in ${timeZone} — ` +
        `next run ${this.nextScheduledRunAt().toISOString()}`,
    );
  }

  /** When the scheduled scan fires next, as an absolute instant. */
  nextScheduledRunAt(): Date {
    return this.job.nextDate().toJSDate();
  }

  /**
   * One scan: the same query as `GET /leases/expiring`, logged as one block
   * per run in the layout `RabbitmqService` uses for a delivery.
   *
   * Throws on failure. The HTTP trigger wants that — the caller gets a 500 and
   * the logging interceptor records it. The scheduled trigger catches it in
   * `runScheduled`.
   */
  async scan(
    trigger: LeaseExpiryScanTrigger,
  ): Promise<LeaseExpiryScanResultDto> {
    const scannedAt = new Date();
    const windowDays = this.config.expiryDays;

    const leases = await this.leases.findExpiring(windowDays);

    this.logger.log(`\n${SEPARATOR}`);
    this.logger.log(
      `[LEASE EXPIRY SCAN] ${trigger} — windowDays=[${windowDays.join(', ')}]`,
    );
    for (const lease of leases) {
      this.logger.log(
        `  ${lease.id} daysLeft=${lease.daysLeft} ` +
          `ends=${lease.endDate.toISOString()} ` +
          `unit=${lease.unitId} membership=${lease.membershipId}`,
      );
    }
    this.logger.log(
      `[SCANNED] ${leases.length} lease(s) +${Date.now() - scannedAt.getTime()}ms`,
    );
    this.logger.log(`${SEPARATOR}\n`);

    return {
      trigger,
      scannedAt,
      nextScheduledRunAt: this.nextScheduledRunAt(),
      windowDays,
      leases,
    };
  }

  /**
   * The scheduled path, which must never throw.
   *
   * Nothing is waiting on a timer callback to report a failure to. `cron` would
   * catch the rejection itself, but only to `console.error` it — outside Nest's
   * logger, without the context that says which job failed. A database blip at
   * 08:00 should leave one clear error line and a scan that runs again
   * tomorrow.
   */
  private async runScheduled(): Promise<void> {
    try {
      await this.scan('scheduled');
    } catch (cause) {
      this.logger.error(
        `[LEASE EXPIRY SCAN FAILED] scheduled — ` +
          `${cause instanceof Error ? cause.message : String(cause)}; ` +
          `next run ${this.nextScheduledRunAt().toISOString()}`,
      );
      if (cause instanceof Error && cause.stack) this.logger.error(cause.stack);
    }
  }
}
