import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  ExpiringLeaseDto,
  LeaseExpiryPeriodDto,
} from '@/modules/leases/dto/expiring-leases-response.dto';
import { Lease } from '@/modules/leases/lease.entity';

/**
 * "Now" as the database sees it, in UTC, as a `timestamp without time zone` —
 * the same type and zone jarvis stores dates in.
 *
 * Computed in SQL rather than passed as a `Date` parameter, and that is the
 * whole point: `pg` serialises a `Date` in the *process's* local zone
 * (`...T12:00:00+03:00`), and Postgres casting that to a zone-less timestamp
 * drops the offset instead of converting it. Every boundary would land three
 * hours late on this machine, silently, and differently on a server in UTC.
 */
const NOW_UTC = `(now() AT TIME ZONE 'UTC')`;

/**
 * Whole days until the lease ends, rounded down — the same count jarvis's
 * `leaseExpiry` shows, so "24 days left" means the same lease in both apps.
 *
 * Computed by the database, in the same statement as the filter, rather than
 * in Node afterwards. Matching an *exact* count makes the two clocks matter: a
 * lease the database sees at 24.00001 days would be 23.99999 by the time Node
 * measured it a few milliseconds later, and would be reported under a period
 * it was not selected for.
 *
 * `CAST(... AS integer)` rather than `::integer`: TypeORM scans the SQL for
 * `:name` and substitutes any parameter of that name, so a `::` cast only works
 * until someone adds a parameter that happens to share the type's name.
 */
const DAYS_LEFT = `CAST(FLOOR(EXTRACT(EPOCH FROM (lease.endDate - ${NOW_UTC})) / 86400) AS integer)`;

@Injectable()
export class LeasesService {
  constructor(
    @InjectRepository(Lease)
    private readonly leases: Repository<Lease>,
  ) {}

  /**
   * Active leases whose days left is exactly one of `periods`, grouped by
   * period in the order given, each group soonest-to-expire first.
   *
   * "Active" is jarvis's own definition (`lib/dashboard.ts`): started, and not
   * yet ended. `startDate <= now` matters here: a short lease that starts next
   * week can already be 24 days from its end without anything being due on it.
   *
   * Leases already renewed need no separate exclusion. jarvis only creates a
   * successor once `endDate` has *passed*, so a lease that has not ended cannot
   * have one yet.
   *
   * One query for every period, not one per period: a lease has a single
   * days-left value, so it can only match one of them, and grouping the result
   * in memory costs nothing.
   *
   * Not scoped to an organization, unlike every query in jarvis: this service
   * works across all of them.
   */
  async findExpiringInPeriods(
    periods: number[],
  ): Promise<LeaseExpiryPeriodDto[]> {
    // `IN ()` is a syntax error in Postgres, and there is nothing to find.
    if (periods.length === 0) return [];

    const { entities, raw } = await this.leases
      .createQueryBuilder('lease')
      .addSelect(DAYS_LEFT, 'daysLeft')
      .where(`lease.startDate <= ${NOW_UTC}`)
      .andWhere(`lease.endDate >= ${NOW_UTC}`)
      .andWhere(`${DAYS_LEFT} IN (:...periods)`, { periods })
      .orderBy('lease.endDate', 'ASC')
      .getRawAndEntities<{ lease_id: string; daysLeft: number }>();

    // The computed column is not part of the entity, so it only exists on the
    // raw rows. Joined back by id rather than by array position, which holds
    // today only because there are no joins to fan rows out.
    const daysLeftById = new Map(
      raw.map((row) => [row.lease_id, row.daysLeft]),
    );

    return periods.map((days) => ({
      days,
      leases: entities
        .filter((lease) => daysLeftById.get(lease.id) === days)
        .map((lease) => toExpiringLeaseDto(lease, days)),
    }));
  }
}

function toExpiringLeaseDto(lease: Lease, daysLeft: number): ExpiringLeaseDto {
  return {
    id: lease.id,
    unitId: lease.unitId,
    membershipId: lease.membershipId,
    startDate: lease.startDate,
    endDate: lease.endDate,
    daysLeft,
    durationMonths: lease.durationMonths,
    monthlyRent: lease.monthlyRent,
    leaseAmount: lease.leaseAmount,
    renewedFromId: lease.renewedFromId,
  };
}
