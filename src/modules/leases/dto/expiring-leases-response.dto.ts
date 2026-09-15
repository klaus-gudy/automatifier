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
    example: 16,
    description:
      'Whole days until `endDate`, rounded down — the same count jarvis ' +
      'shows on its lease list, so the two never disagree about a lease ' +
      'by one day.',
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

export class LeaseExpiryPeriodDto {
  @ApiProperty({
    example: 24,
    description:
      'One entry from LEASE_EXPIRY_DAYS. Every lease below has exactly this ' +
      'many whole days left.',
  })
  days: number;

  @ApiProperty({
    type: [ExpiringLeaseDto],
    description: 'Soonest to expire first. Empty when nothing matches.',
  })
  leases: ExpiringLeaseDto[];
}

export class ExpiringLeasesResponseDto {
  @ApiProperty({
    type: [LeaseExpiryPeriodDto],
    description:
      'One entry per configured period, furthest first — including periods ' +
      'with no leases, so the response shows what is configured.',
  })
  periods: LeaseExpiryPeriodDto[];
}
