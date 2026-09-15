import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ExpiringLeaseDto } from '@/modules/leases/dto/expiring-leases-response.dto';
import { Lease } from '@/modules/leases/lease.entity';

const DAY_MS = 24 * 60 * 60 * 1000;

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

@Injectable()
export class LeasesService {
  constructor(
    @InjectRepository(Lease)
    private readonly leases: Repository<Lease>,
  ) {}

  /**
   * Leases that are running now and end within the next `windowDays` days,
   * soonest first.
   *
   * The filter mirrors jarvis's own "renewals due" panel (`lib/dashboard.ts`)
   * on purpose — started, not yet ended, end inside the window, both bounds
   * inclusive — so this service and the dashboard describe the same set of
   * leases rather than two slightly different ones.
   *
   * `startDate <= now` matters: an upcoming lease that is short, or starts
   * next week, has an end date inside the window without anything being due
   * on it yet.
   *
   * Leases already renewed need no separate exclusion. jarvis only creates a
   * successor once `endDate` has *passed*, so a lease still inside this window
   * cannot have one yet.
   *
   * Not scoped to an organization, unlike every query in jarvis: this service
   * works across all of them.
   */
  async findExpiring(windowDays: number): Promise<ExpiringLeaseDto[]> {
    const rows = await this.leases
      .createQueryBuilder('lease')
      .where(`lease.startDate <= ${NOW_UTC}`)
      .andWhere(`lease.endDate >= ${NOW_UTC}`)
      .andWhere(
        `lease.endDate <= ${NOW_UTC} + make_interval(days => :windowDays)`,
        { windowDays },
      )
      .orderBy('lease.endDate', 'ASC')
      .getMany();

    const now = Date.now();

    return rows.map((lease) => ({
      id: lease.id,
      unitId: lease.unitId,
      membershipId: lease.membershipId,
      startDate: lease.startDate,
      endDate: lease.endDate,
      // Floored, as jarvis's `leaseExpiry` does: a lease ending in 16.9 days
      // reads "16 days left" in both places.
      daysLeft: Math.floor((lease.endDate.getTime() - now) / DAY_MS),
      durationMonths: lease.durationMonths,
      monthlyRent: lease.monthlyRent,
      leaseAmount: lease.leaseAmount,
      renewedFromId: lease.renewedFromId,
    }));
  }
}
