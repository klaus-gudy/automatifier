import { ApiProperty } from '@nestjs/swagger';

export class ExpiringLeaseMembershipDto {
  @ApiProperty({ example: 'cmf3k2x9d0003qz8h5e6f7g8h' })
  id: string;

  @ApiProperty({ example: 'James Mchaga', nullable: true, type: String })
  name: string | null;

  @ApiProperty({
    example: '0712345678',
    nullable: true,
    type: String,
    description:
      'As jarvis stores it — local or international, unnormalised. The SMS ' +
      'payload converts it; this reports the record.',
  })
  phone: string | null;

  @ApiProperty({
    example: 'Tenant',
    description:
      "The membership's role in its organization. Free text and editable per " +
      'organization, so anything matching on it compares case-insensitively.',
  })
  role: string;
}

export class ExpiringLeaseUnitDto {
  @ApiProperty({ example: 'cmf3k2x9d0002qz8h1a2b3c4d' })
  id: string;

  @ApiProperty({
    example: 'Z1',
    description:
      "The unit's label within its property — jarvis's `Unit.label`.",
  })
  label: string;

  @ApiProperty({ example: 'Old Baruti Estate' })
  propertyName: string;
}

export class ExpiringLeaseDto {
  @ApiProperty({ example: 'cmf3k2x9d0001qz8h7v6y5t4r' })
  id: string;

  @ApiProperty({
    example: 'cmf3k2x9d0009qz8h2b3c4d5e',
    description:
      "The organization the lease belongs to, through its tenant's " +
      'membership. Reminders are addressed to that organization’s Owners.',
  })
  organizationId: string;

  @ApiProperty({
    type: ExpiringLeaseMembershipDto,
    description: 'The tenant on this lease.',
  })
  membership: ExpiringLeaseMembershipDto;

  @ApiProperty({ type: ExpiringLeaseUnitDto })
  unit: ExpiringLeaseUnitDto;

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

/** What one scan did to the outbox. */
export class LeaseReminderTallyDto {
  @ApiProperty({
    example: 3,
    description: 'Rows written this run — the ones a later step will publish.',
  })
  created: number;

  @ApiProperty({
    example: 2,
    description:
      'Reminders that already existed for this lease, period and recipient, ' +
      'so nothing was written. The de-duplication doing its job.',
  })
  duplicates: number;

  @ApiProperty({
    example: 1,
    description:
      'Rows written as SKIPPED because the owner has no usable phone number. ' +
      'Recorded rather than dropped, so "why was nobody texted" has an answer.',
  })
  skipped: number;

  @ApiProperty({
    example: 3,
    description:
      'Reminders the broker confirmed during this run — including any left ' +
      'pending by earlier runs, since a scan publishes everything waiting, ' +
      'not only what it just recorded.',
  })
  published: number;

  @ApiProperty({
    example: 0,
    description:
      'Reminders that failed to publish and are left for the sweeper. Zero ' +
      'unless the broker is unreachable or refusing.',
  })
  failed: number;
}

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

  @ApiProperty({ type: LeaseReminderTallyDto })
  reminders: LeaseReminderTallyDto;
}
