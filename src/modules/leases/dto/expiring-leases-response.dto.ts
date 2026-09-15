import { ApiProperty } from '@nestjs/swagger';

export class ExpiringLeaseDto {
  @ApiProperty({ example: 'cmf3k2x9d0001qz8h7v6y5t4r' })
  id: string;

  @ApiProperty({ example: 'cmf3k2x9d0002qz8h1a2b3c4d' })
  unitId: string;

  @ApiProperty({
    example: 'cmf3k2x9d0003qz8h5e6f7g8h',
    description: "The tenant's membership in the owning organization.",
  })
  membershipId: string;

  @ApiProperty({ example: '2025-10-01T00:00:00.000Z' })
  startDate: Date;

  @ApiProperty({ example: '2026-10-01T00:00:00.000Z' })
  endDate: Date;

  @ApiProperty({
    example: 24,
    description:
      'Whole days until `endDate`, rounded down — the same count jarvis ' +
      'shows on its lease list. Always one of `windowDays`, which is how a ' +
      'caller tells which period a lease matched.',
  })
  daysLeft: number;

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

export class ExpiringLeasesResponseDto {
  @ApiProperty({
    example: [24, 1],
    type: [Number],
    description:
      'The configured LEASE_EXPIRY_DAYS, furthest first. A lease is listed ' +
      'when its whole days left equals one of these exactly — not "this many ' +
      'or fewer".',
  })
  windowDays: number[];

  @ApiProperty({
    type: [ExpiringLeaseDto],
    description:
      'Every matching lease in one list, soonest to expire first. Empty when ' +
      'nothing matches.',
  })
  leases: ExpiringLeaseDto[];
}

export type LeaseExpiryScanTrigger = 'scheduled' | 'manual';

export class LeaseExpiryScanResultDto extends ExpiringLeasesResponseDto {
  @ApiProperty({
    example: 'manual',
    enum: ['scheduled', 'manual'],
    description:
      '"scheduled" when the daily job ran it, "manual" when it was ' +
      'requested through the API.',
  })
  trigger: LeaseExpiryScanTrigger;

  @ApiProperty({ example: '2026-09-16T05:00:00.012Z' })
  scannedAt: Date;

  @ApiProperty({
    example: '2026-09-17T05:00:00.000Z',
    description:
      'When the scheduled scan runs next, in UTC — 05:00Z is 08:00 in ' +
      'Africa/Dar_es_Salaam.',
  })
  nextScheduledRunAt: Date;
}
