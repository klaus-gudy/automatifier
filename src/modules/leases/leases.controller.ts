import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ExpiringLeasesResponseDto } from '@/modules/leases/dto/expiring-leases-response.dto';
import { LeasesService } from '@/modules/leases/leases.service';

/**
 * Fixed rather than a query parameter for now. The window is the one thing
 * every later step (notices, reminders) will key off, so it stays a single
 * decision in one place until a caller genuinely needs a different one.
 */
const EXPIRY_WINDOW_DAYS = 30;

@ApiTags('leases')
@Controller('leases')
export class LeasesController {
  constructor(private readonly leases: LeasesService) {}

  @Get('expiring')
  @ApiOperation({
    summary: 'Leases expiring within the next 30 days',
    description:
      'Every lease, across all organizations, that has started and ends ' +
      'between now and 30 days from now (inclusive), soonest first.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: ExpiringLeasesResponseDto })
  async findExpiring(): Promise<ExpiringLeasesResponseDto> {
    return {
      windowDays: EXPIRY_WINDOW_DAYS,
      leases: await this.leases.findExpiring(EXPIRY_WINDOW_DAYS),
    };
  }
}
