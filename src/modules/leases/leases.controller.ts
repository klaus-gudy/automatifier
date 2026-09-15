import { Controller, Get, HttpStatus, Inject } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import leaseConfig from '@/config/lease.config';
import { ExpiringLeasesResponseDto } from '@/modules/leases/dto/expiring-leases-response.dto';
import { LeasesService } from '@/modules/leases/leases.service';

@ApiTags('leases')
@Controller('leases')
export class LeasesController {
  constructor(
    private readonly leases: LeasesService,
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
}
