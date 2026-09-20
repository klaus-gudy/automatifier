import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import leaseConfig from '@/config/lease.config';
import { RenewalEventService } from '@/modules/renewals/renewal-event.service';

export const RENEWAL_EVENT_SWEEP_JOB = 'renewal-event-sweep';

/**
 * Retries renewal events that were recorded but never published — the half
 * that makes `renewal_event` an outbox rather than a ledger.
 *
 * The scan publishes what it records, so anything still `PENDING` got stuck:
 * the broker was down, a process died mid-batch, a publish timed out. Without
 * this, the unique constraint that stops the daily repeat would also stop the
 * retry — tomorrow's scan records nothing for that lease, so nothing would
 * ever publish it.
 *
 * Shares `LEASE_REMINDER_SWEEP_CRON` with the reminder sweeper: both are "retry
 * what is stuck", and two knobs for one decision is one more than anyone will
 * keep in step.
 */
@Injectable()
export class RenewalEventSweeperService implements OnModuleInit {
  private readonly logger = new Logger(RenewalEventSweeperService.name);
  private job!: CronJob;

  constructor(
    private readonly events: RenewalEventService,
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
      // A slow batch must not have the next tick start on top of it.
      waitForCompletion: true,
      name: RENEWAL_EVENT_SWEEP_JOB,
    });

    this.scheduler.addCronJob(RENEWAL_EVENT_SWEEP_JOB, this.job);
    this.job.start();

    this.logger.log(
      `renewal event sweep scheduled "${cronTime}" in ${timeZone}`,
    );
  }

  /** Never throws: a failed pass logs one error and waits for the next tick. */
  private async sweep(): Promise<void> {
    try {
      const { published, failed } = await this.events.publishPending();
      // Silent when there is nothing stuck, which is most ticks.
      if (published || failed) {
        this.logger.log(
          `[RENEWAL EVENT SWEEP] ${published} published, ${failed} still pending`,
        );
      }
    } catch (cause) {
      this.logger.error(
        `[RENEWAL EVENT SWEEP FAILED] ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      );
      if (cause instanceof Error && cause.stack) this.logger.error(cause.stack);
    }
  }
}
