import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import leaseConfig from '@/config/lease.config';
import { LeaseReminderService } from '@/modules/leases/lease-reminder.service';

export const LEASE_REMINDER_SWEEP_JOB = 'lease-reminder-sweep';

/**
 * Retries reminders that were recorded but never published.
 *
 * **This is the half that makes the table an outbox rather than a ledger.** The
 * scan publishes what it records, so everything here got stuck: the broker was
 * down at 08:00, a process died mid-batch, a publish timed out. Without this,
 * such a reminder sits `PENDING` forever while the lease it refers to quietly
 * passes the day it was meant to warn about — which is the exact failure the
 * table was introduced to prevent, only with a row to prove it happened.
 *
 * Runs far more often than the daily scan, because a reminder is only useful
 * before its date. Each pass is bounded by `LEASE_REMINDER_BATCH_SIZE`, and
 * `publishPending` claims rows with `SKIP LOCKED`, so a sweep landing on top of
 * a scan costs nothing worse than an empty batch.
 */
@Injectable()
export class LeaseReminderSweeperService implements OnModuleInit {
  private readonly logger = new Logger(LeaseReminderSweeperService.name);
  private job!: CronJob;

  constructor(
    private readonly reminders: LeaseReminderService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(leaseConfig.KEY)
    private readonly config: ConfigType<typeof leaseConfig>,
  ) {}

  onModuleInit(): void {
    const { reminderSweepCron: cronTime, expiryScanTimeZone: timeZone } =
      this.config;

    this.job = CronJob.from({
      cronTime,
      timeZone,
      onTick: () => this.sweep(),
      // A slow batch must not have the next tick start on top of it. The
      // claim would skip its locked rows anyway; this avoids the pile-up.
      waitForCompletion: true,
      name: LEASE_REMINDER_SWEEP_JOB,
    });

    this.scheduler.addCronJob(LEASE_REMINDER_SWEEP_JOB, this.job);
    this.job.start();

    this.logger.log(
      `lease reminder sweep scheduled "${cronTime}" in ${timeZone}`,
    );
  }

  /**
   * One pass, which must never throw — nothing is waiting on a timer callback
   * to report a failure to, and a sweep that crashes the process would take
   * the 08:00 scan with it.
   *
   * Quiet when there is nothing to do: this runs every ten minutes, and a line
   * each time saying "0 published" would bury the ones that matter.
   */
  private async sweep(): Promise<void> {
    try {
      const { published, failed } = await this.reminders.publishPending();

      if (published > 0 || failed > 0) {
        this.logger.log(
          `[REMINDER SWEEP] ${published} published, ${failed} still pending`,
        );
      }
    } catch (cause) {
      this.logger.error(
        `[REMINDER SWEEP FAILED] ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      );
      if (cause instanceof Error && cause.stack) this.logger.error(cause.stack);
    }
  }
}
