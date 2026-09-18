import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { OverdueRenewalsResponseDto } from '@/modules/renewals/dto/overdue-renewals-response.dto';
import { RenewalsService } from '@/modules/renewals/renewals.service';

@ApiTags('renewals')
@Controller('renewals')
export class RenewalsController {
  constructor(private readonly renewals: RenewalsService) {}

  @Get('overdue')
  @ApiOperation({
    summary: 'Ended leases that have not been renewed',
    description:
      'Every lease, across all organizations, that jarvis still marks ' +
      'Active although its end date has passed — longest overdue first.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: OverdueRenewalsResponseDto })
  async findOverdue(): Promise<OverdueRenewalsResponseDto> {
    return { leases: await this.renewals.findOverdue() };
  }
}
