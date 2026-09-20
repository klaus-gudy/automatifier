import { ApiProperty } from '@nestjs/swagger';

import {
  ExpiringLeaseMembershipDto,
  ExpiringLeaseUnitDto,
} from '@/modules/leases/dto/expiring-leases-response.dto';

export class OverdueRenewalLeaseDto {
  @ApiProperty({ example: 'cmf3k2x9d0001qz8h7v6y5t4r' })
  id: string;

  @ApiProperty({ example: 'cmf3k2x9d0009qz8h2b3c4d5e' })
  organizationId: string;

  @ApiProperty({
    type: ExpiringLeaseMembershipDto,
    description: 'The tenant on this lease.',
  })
  membership: ExpiringLeaseMembershipDto;

  @ApiProperty({ type: ExpiringLeaseUnitDto })
  unit: ExpiringLeaseUnitDto;

  @ApiProperty({
    example: true,
    description:
      "The unit's `autoRenew` flag in jarvis — whether this lease is meant " +
      'to be renewed automatically rather than by hand.',
  })
  autoRenew: boolean;

  @ApiProperty({ example: '2025-09-01T00:00:00.000Z' })
  startDate: Date;

  @ApiProperty({ example: '2026-09-01T00:00:00.000Z' })
  endDate: Date;

  @ApiProperty({
    example: 17,
    description:
      'Calendar days since `endDate`, counted in LEASE_EXPIRY_SCAN_TIMEZONE ' +
      '— the same counting as `daysLeft` on expiring leases, turned around.',
  })
  daysOverdue: number;

  @ApiProperty({ example: 12 })
  durationMonths: number;

  @ApiProperty({ example: 450000 })
  monthlyRent: number;

  @ApiProperty({ example: 5400000 })
  leaseAmount: number;

  @ApiProperty({
    example: null,
    nullable: true,
    type: String,
    description: 'The lease this one renewed, when it was itself a renewal.',
  })
  renewedFromId: string | null;
}

export class OverdueRenewalsResponseDto {
  @ApiProperty({
    type: [OverdueRenewalLeaseDto],
    description:
      'Every lease still Active past its end date, longest overdue first. ' +
      'Empty when nothing is waiting on a renewal.',
  })
  leases: OverdueRenewalLeaseDto[];
}

export type RenewalScanTrigger = 'scheduled' | 'manual';

/** What one scan did to the outbox, per kind of event. */
export class RenewalPublishTallyDto {
  @ApiProperty({
    example: 2,
    description: 'Rows recorded this run — the leases not already published.',
  })
  created: number;

  @ApiProperty({
    example: 3,
    description:
      'Leases already recorded for this end date, so nothing was written. ' +
      'The de-duplication doing its job: an overdue lease is published once, ' +
      'not once a day.',
  })
  duplicates: number;

  @ApiProperty({
    example: 2,
    description:
      'Events the broker confirmed during this run — including any left ' +
      'pending by earlier runs, so this is a whole-outbox figure rather ' +
      'than a per-kind one.',
  })
  published: number;

  @ApiProperty({
    example: 0,
    description:
      'Events that failed to publish and are left for the sweeper ' +
      '(LEASE_REMINDER_SWEEP_CRON).',
  })
  failed: number;
}

export class RenewalScanResultDto {
  @ApiProperty({ example: 'manual', enum: ['scheduled', 'manual'] })
  trigger: RenewalScanTrigger;

  @ApiProperty({ example: '2026-09-19T05:30:00.012Z' })
  scannedAt: Date;

  @ApiProperty({
    example: '2026-09-20T05:30:00.000Z',
    description: 'When the scheduled scan runs next, in UTC.',
  })
  nextScheduledRunAt: Date;

  @ApiProperty({
    type: [OverdueRenewalLeaseDto],
    description: 'What /renewals/auto returned in this run.',
  })
  autoRenew: OverdueRenewalLeaseDto[];

  @ApiProperty({
    type: [OverdueRenewalLeaseDto],
    description: 'What /renewals/vacate returned in this run.',
  })
  vacate: OverdueRenewalLeaseDto[];

  @ApiProperty({
    type: RenewalPublishTallyDto,
    description: 'lease.renewal events, one per autoRenew lease.',
  })
  renewalEvents: RenewalPublishTallyDto;

  @ApiProperty({
    type: RenewalPublishTallyDto,
    description: 'lease.vacating events, one per vacate lease.',
  })
  vacatingEvents: RenewalPublishTallyDto;
}
