import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import leaseConfig from '@/config/lease.config';
import {
  ExpiringLeasesResponseDto,
  LeaseExpiryScanResultDto,
} from '@/modules/leases/dto/expiring-leases-response.dto';
import { LeaseExpiryScanService } from '@/modules/leases/lease-expiry-scan.service';
import { LeasesService } from '@/modules/leases/leases.service';

@ApiTags('leases')
@Controller('leases')
export class LeasesController {
  constructor(
    private readonly leases: LeasesService,
    private readonly scanner: LeaseExpiryScanService,
    @Inject(leaseConfig.KEY)
    private readonly config: ConfigType<typeof leaseConfig>,
  ) {}

  /**
   * The periods come from `LEASE_EXPIRY_DAYS` and nothing else — no query
   * parameter to override them. Every later step (notices, reminders) keys off
   * the same periods, so they stay one decision made in one place; a caller
   * able to ask for its own would see leases the rest of the service never acts
   * on.
   *
   * `windowDays` echoes that configuration back so a reader of the response
   * can tell an empty `leases` ("nothing due") from a misconfigured service
   * ("looking at the wrong days").
   */
  @Get('expiring')
  @ApiOperation({
    summary: 'Active leases expiring in the configured periods',
    description:
      'Every lease, across all organizations, that has started and has ' +
      'exactly one of LEASE_EXPIRY_DAYS whole days left — returned as the ' +
      'configured days followed by one list of leases, soonest first.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: ExpiringLeasesResponseDto })
  async findExpiring(): Promise<ExpiringLeasesResponseDto> {
    const windowDays = this.config.expiryDays;

    return {
      windowDays,
      leases: await this.leases.findExpiring(windowDays),
    };
  }

  /**
   * Runs the scheduled scan immediately, through exactly the same code path,
   * so it can be exercised without waiting for 08:00.
   *
   * `POST`, not `GET`, although it changes no data: a scan is an action with
   * an effect (today a block in the log, later notices sent), and a `GET` is
   * something browsers prefetch, crawlers follow and proxies retry freely.
   * `200` rather than `POST`'s default `201`, because nothing is created.
   */
  @Post('expiring/scan')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run the lease expiry scan now',
    description:
      'Runs the same scan the daily schedule runs (LEASE_EXPIRY_SCAN_CRON in ' +
      'LEASE_EXPIRY_SCAN_TIMEZONE, 08:00 Africa/Dar_es_Salaam by default): ' +
      'finds the expiring leases, logs them, and returns what it found plus ' +
      'when the scheduled scan runs next.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: LeaseExpiryScanResultDto })
  scan(): Promise<LeaseExpiryScanResultDto> {
    return this.scanner.scan('manual');
  }
}
