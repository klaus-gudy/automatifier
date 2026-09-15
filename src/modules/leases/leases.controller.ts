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
   */
  @Get('expiring')
  @ApiOperation({
    summary: 'Active leases expiring in the configured periods',
    description:
      'For each period in LEASE_EXPIRY_DAYS (furthest first), every lease ' +
      'across all organizations that has started and has exactly that many ' +
      'whole days left. A period with no leases is still listed, with an ' +
      'empty array.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: ExpiringLeasesResponseDto })
  async findExpiring(): Promise<ExpiringLeasesResponseDto> {
    return {
      periods: await this.leases.findExpiringInPeriods(this.config.expiryDays),
    };
  }
}
