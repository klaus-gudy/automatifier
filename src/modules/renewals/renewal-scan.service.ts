import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { SEPARATOR } from '@/common/logging/log-format';
import leaseConfig from '@/config/lease.config';
import { RabbitmqService } from '@/messaging/rabbitmq.service';
import {
  OverdueRenewalLeaseDto,
  RenewalPublishTallyDto,
  RenewalScanResultDto,
  RenewalScanTrigger,
} from '@/modules/renewals/dto/overdue-renewals-response.dto';
import { RenewalsService } from '@/modules/renewals/renewals.service';

export const RENEWAL_SCAN_JOB = 'renewal-scan';

/**
 * Runs the `/renewals/auto` and `/renewals/vacate` searches on a schedule, and
 * on demand through `POST /renewals/scan`, logs what each found, and publishes
 * one event per lease: `lease.renewal` for the first list, `lease.vacating`
 * for the second.
 *
 * Registered through `SchedulerRegistry` for the reasons given on
 * `LeaseExpiryScanService`: a `@Cron` decorator is evaluated before `.env` is
 * read, and a job outside the registry would outlive `app.close()`.
 *
 * **Publishes the same lease again on every run** until jarvis moves it out
 * of `Active`. There is no outbox or de-duplication here, unlike reminders:
 * consumers must treat these events as idempotent, keyed on `lease.id`. The
 * same holds for two replicas, which would each publish every lease.
 */
@Injectable()
export class RenewalScanService implements OnModuleInit {
  private readonly logger = new Logger(RenewalScanService.name);
  private job!: CronJob;

  constructor(
    private readonly renewals: RenewalsService,
    private readonly rabbitmq: RabbitmqService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(leaseConfig.KEY)
    private readonly config: ConfigType<typeof leaseConfig>,
  ) {}

  onModuleInit(): void {
    const { renewalScanCron: cronTime, expiryScanTimeZone: timeZone } =
      this.config;

    // Throws on a bad expression or zone, stopping the boot instead of never
    // firing.
    this.job = CronJob.from({
      cronTime,
      timeZone,
      onTick: () => this.runScheduled(),
      waitForCompletion: true,
      name: RENEWAL_SCAN_JOB,
    });

    this.scheduler.addCronJob(RENEWAL_SCAN_JOB, this.job);
    this.job.start();

    this.logger.log(
      `renewal scan scheduled "${cronTime}" in ${timeZone} — ` +
        `next run ${this.nextScheduledRunAt().toISOString()}`,
    );
  }

  nextScheduledRunAt(): Date {
    return this.job.nextDate().toJSDate();
  }

  /**
   * Both searches, run in sequence rather than in parallel: they are two
   * reads of the same small table, and sequential keeps their log lines in
   * order. Throws on failure; `runScheduled` catches for the timer.
   */
  async scan(trigger: RenewalScanTrigger): Promise<RenewalScanResultDto> {
    const scannedAt = new Date();

    const autoRenew = await this.renewals.findDueForAutoRenewal();
    const vacate = await this.renewals.findDueForVacating();

    this.logger.log(`\n${SEPARATOR}`);
    this.logger.log(`[RENEWAL SCAN] ${trigger}`);
    this.logList('AUTO-RENEW', autoRenew);
    this.logList('VACATE', vacate);

    const renewalEvents = await this.publishEach(
      this.config.renewalRoutingKey,
      autoRenew,
    );
    const vacatingEvents = await this.publishEach(
      this.config.vacatingRoutingKey,
      vacate,
    );

    this.logger.log(
      `[SCANNED] ${autoRenew.length} to auto-renew ` +
        `(${renewalEvents.published} published, ${renewalEvents.failed} failed), ` +
        `${vacate.length} to vacate ` +
        `(${vacatingEvents.published} published, ${vacatingEvents.failed} failed) ` +
        `+${Date.now() - scannedAt.getTime()}ms`,
    );
    this.logger.log(`${SEPARATOR}\n`);

    return {
      trigger,
      scannedAt,
      nextScheduledRunAt: this.nextScheduledRunAt(),
      autoRenew,
      vacate,
      renewalEvents,
      vacatingEvents,
    };
  }

  /**
   * One event per lease, so a consumer can act on — and fail on — each lease
   * on its own rather than a whole batch at once.
   *
   * A failure is logged and counted, not thrown: one lease the broker refused
   * should not stop the others being published. It is not retried either —
   * the lease is still Active tomorrow and the next scan publishes it again.
   */
  private async publishEach(
    routingKey: string,
    leases: OverdueRenewalLeaseDto[],
  ): Promise<RenewalPublishTallyDto> {
    // Disabled in config, so nothing to publish to — the scan still logs.
    if (!this.rabbitmq.isEnabled) return { published: 0, failed: 0 };

    let published = 0;
    let failed = 0;

    for (const lease of leases) {
      try {
        await this.rabbitmq.publish(routingKey, { lease });
        published += 1;
      } catch (cause) {
        failed += 1;
        this.logger.error(
          `${routingKey} for lease ${lease.id} failed to publish: ` +
            `${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }

    return { published, failed };
  }

  private logList(label: string, leases: OverdueRenewalLeaseDto[]): void {
    this.logger.log(`  ${label}: ${leases.length}`);
    for (const lease of leases) {
      this.logger.log(
        `    ${lease.id} daysOverdue=${lease.daysOverdue} ` +
          `ended=${lease.endDate.toISOString()} ` +
          `${lease.unit.propertyName} - Unit ${lease.unit.label} ` +
          `tenant=${lease.membership.name ?? '(unnamed)'}`,
      );
    }
  }

  /** Never throws: a failed tick logs one error and waits for tomorrow. */
  private async runScheduled(): Promise<void> {
    try {
      await this.scan('scheduled');
    } catch (cause) {
      this.logger.error(
        `[RENEWAL SCAN FAILED] scheduled — ` +
          `${cause instanceof Error ? cause.message : String(cause)}; ` +
          `next run ${this.nextScheduledRunAt().toISOString()}`,
      );
      if (cause instanceof Error && cause.stack) this.logger.error(cause.stack);
    }
  }
}
