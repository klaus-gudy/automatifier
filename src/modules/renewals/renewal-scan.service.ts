import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { SEPARATOR } from '@/common/logging/log-format';
import leaseConfig from '@/config/lease.config';
import {
  OverdueRenewalLeaseDto,
  RenewalScanResultDto,
  RenewalScanTrigger,
} from '@/modules/renewals/dto/overdue-renewals-response.dto';
import { RenewalEventService } from '@/modules/renewals/renewal-event.service';
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
 * Each lease is published **once**, not once per run: the scan records into
 * `renewal_event` first and publishes only the rows it actually inserted, so a
 * lease that stays overdue for a week still produces one event. Two replicas
 * scanning at the same moment are safe for the same reason — the unique
 * constraint decides, not either process.
 */
@Injectable()
export class RenewalScanService implements OnModuleInit {
  private readonly logger = new Logger(RenewalScanService.name);
  private job!: CronJob;

  constructor(
    private readonly renewals: RenewalsService,
    private readonly events: RenewalEventService,
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

    /*
     * Recorded first, published second, and never the other way round — the
     * rule the reminders follow, for the same reason: a row nobody published
     * is retried by the sweeper, while a message with no row behind it is one
     * nobody can account for.
     */
    const recordedRenewals = await this.events.recordFor('RENEWAL', autoRenew);
    const recordedVacating = await this.events.recordFor('VACATING', vacate);
    const publishedNow = await this.events.publishPending();

    const renewalEvents = { ...recordedRenewals, ...publishedNow };
    const vacatingEvents = { ...recordedVacating, ...publishedNow };

    this.logger.log(
      `[SCANNED] ${autoRenew.length} to auto-renew ` +
        `(${recordedRenewals.created} new, ${recordedRenewals.duplicates} already recorded), ` +
        `${vacate.length} to vacate ` +
        `(${recordedVacating.created} new, ${recordedVacating.duplicates} already recorded) ` +
        `— ${publishedNow.published} event(s) published, ` +
        `${publishedNow.failed} left for the sweeper ` +
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
