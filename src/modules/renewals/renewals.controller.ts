import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  OverdueRenewalsResponseDto,
  RenewalScanResultDto,
} from '@/modules/renewals/dto/overdue-renewals-response.dto';
import { RenewalScanService } from '@/modules/renewals/renewal-scan.service';
import { RenewalsService } from '@/modules/renewals/renewals.service';

@ApiTags('renewals')
@Controller('renewals')
export class RenewalsController {
  constructor(
    private readonly renewals: RenewalsService,
    private readonly scanner: RenewalScanService,
  ) {}

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

  @Get('auto')
  @ApiOperation({
    summary: 'Ended leases due for auto-renewal',
    description:
      'The same leases as /renewals/overdue — still Active past their end ' +
      'date — narrowed to those whose unit has autoRenew on. Each is one ' +
      "jarvis's auto-renewal has not yet renewed.",
  })
  @ApiResponse({ status: HttpStatus.OK, type: OverdueRenewalsResponseDto })
  async findDueForAutoRenewal(): Promise<OverdueRenewalsResponseDto> {
    return { leases: await this.renewals.findDueForAutoRenewal() };
  }

  @Get('vacate')
  @ApiOperation({
    summary: 'Ended leases due for vacating',
    description:
      'The same leases as /renewals/overdue — still Active past their end ' +
      'date — narrowed to those whose unit has autoRenew off. Nothing will ' +
      'renew these automatically, so the unit is due to be vacated.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: OverdueRenewalsResponseDto })
  async findDueForVacating(): Promise<OverdueRenewalsResponseDto> {
    return { leases: await this.renewals.findDueForVacating() };
  }

  /**
   * Runs the scheduled scan now, through the same code path. `POST` with a
   * `200` for the reasons given on `POST /leases/expiring/scan`.
   */
  @Post('scan')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run the renewal scan now',
    description:
      'Runs what the daily schedule runs (RENEWAL_SCAN_CRON in ' +
      'LEASE_EXPIRY_SCAN_TIMEZONE, 08:30 Africa/Dar_es_Salaam by default): ' +
      'the /renewals/auto and /renewals/vacate searches, logged, published ' +
      'as one lease.renewal or lease.vacating event per lease, and returned.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: RenewalScanResultDto })
  scan(): Promise<RenewalScanResultDto> {
    return this.scanner.scan('manual');
  }
}
