import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import leaseConfig from '@/config/lease.config';
import { JARVIS_SCHEMA } from '@/database/schema';
import { ExpiringLeaseDto } from '@/modules/leases/dto/expiring-leases-response.dto';
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
 * Days until the lease ends, counted as **calendar days** in the reminder time
 * zone (`$2`): the date it ends, minus today's date.
 *
 * It used to be elapsed time rounded down — `floor((endDate - now) / 1 day)`,
 * matching jarvis's own `leaseExpiry`. That is a different number, and the
 * difference is not academic. On 18 September at 11:57 EAT a lease ending
 * 2026-09-20 has 39 hours left, so the old expression called it **1 day** while
 * every human involved calls it 2 — and "1 day left" then meant "some time in
 * the next 24 to 48 hours", which cannot be phrased as "ends tomorrow" in a
 * message. Counting dates makes `daysLeft = 1` mean tomorrow, exactly.
 *
 * **This now disagrees with jarvis's screens by one day** for any lease whose
 * end date is stored at 00:00 UTC, which is all of them. Deliberate: the number
 * in a text message has to match the reader's calendar.
 *
 * Two conversions, not one. jarvis stores end dates as zone-less timestamps
 * holding UTC, so `AT TIME ZONE 'UTC'` reads the stored value as an instant and
 * the second `AT TIME ZONE $2` moves that instant into local time — where
 * midnight UTC is 03:00, and therefore still the same date the tenant would
 * name. Casting the UTC value straight to a date would be a day early for every
 * lease after 21:00 local.
 *
 * Computed by the database, in the same statement as the filter, so the value
 * reported is the value that was matched on.
 */
const DAYS_LEFT = `(
        (lease."endDate" AT TIME ZONE 'UTC' AT TIME ZONE $2)::date
      - (now() AT TIME ZONE $2)::date
      )`;

/** Matches jarvis's `isOwnerRole`: role names are editable free text. */
const OWNER_ROLE_NAME = 'owner';

/** One person a reminder can be addressed to — an Owner of the organization. */
export interface LeaseRecipient {
  membershipId: string;
  organizationId: string;
  name: string | null;
  phone: string | null;
}

/** One row of the query below, before it is shaped into a DTO. */
interface ExpiringLeaseRow {
  id: string;
  unitId: string;
  membershipId: string;
  startDate: Date;
  endDate: Date;
  durationMonths: number;
  monthlyRent: number;
  leaseAmount: number;
  renewedFromId: string | null;
  daysLeft: number;
  organizationId: string;
  tenantName: string | null;
  tenantPhone: string | null;
  roleName: string;
  unitLabel: string;
  propertyName: string;
}

@Injectable()
export class LeasesService {
  constructor(
    @InjectRepository(Lease)
    private readonly leases: Repository<Lease>,
    /*
     * For the time zone the day count is measured in, and nothing else. It is
     * not a caller's choice: "how many days left" has one answer per service,
     * the one its messages are written in.
     */
    @Inject(leaseConfig.KEY)
    private readonly config: ConfigType<typeof leaseConfig>,
  ) {}

  /**
   * Active leases whose days left is exactly one of `periods`, in one list,
   * soonest to expire first, each carrying the tenant and unit a reminder has
   * to name.
   *
   * "Active" is jarvis's own definition (`lib/dashboard.ts`): started, and not
   * yet ended. `startDate <= now` matters here: a short lease that starts next
   * week can already be 24 days from its end without anything being due on it.
   *
   * Leases already renewed need no separate exclusion. jarvis only creates a
   * successor once `endDate` has *passed*, so a lease that has not ended cannot
   * have one yet.
   *
   * Written as one SQL statement rather than through the query builder, for
   * two reasons. TypeORM splits a join target on its dot, so a
   * schema-qualified `"public"."Membership"` is read as the *alias* `"public"`
   * and fails — and the alternative, mapping `Membership`, `User`, `Role`,
   * `Unit` and `Property` as entities to get relations, would put five more of
   * another application's Prisma-owned tables under this service's
   * maintenance for six scalar columns.
   *
   * Not scoped to an organization, unlike every query in jarvis: this service
   * works across all of them.
   */
  async findExpiring(periods: number[]): Promise<ExpiringLeaseDto[]> {
    // Nothing to match, and `= ANY('{}')` would scan for no reason.
    if (periods.length === 0) return [];

    const rows = await this.leases.manager.query<ExpiringLeaseRow[]>(
      `SELECT lease.id                    AS "id",
              lease."unitId"              AS "unitId",
              lease."membershipId"        AS "membershipId",
              lease."startDate"           AS "startDate",
              lease."endDate"             AS "endDate",
              lease."durationMonths"      AS "durationMonths",
              lease."monthlyRent"         AS "monthlyRent",
              lease."leaseAmount"         AS "leaseAmount",
              lease."renewedFromId"       AS "renewedFromId",
              membership."organizationId" AS "organizationId",
              tenant.name                 AS "tenantName",
              tenant.phone                AS "tenantPhone",
              tenant_role.name            AS "roleName",
              unit.label                  AS "unitLabel",
              property.name               AS "propertyName",
              ${DAYS_LEFT}                AS "daysLeft"
         FROM "${JARVIS_SCHEMA}"."Lease" lease
         JOIN "${JARVIS_SCHEMA}"."Membership" membership
           ON membership.id = lease."membershipId"
         JOIN "${JARVIS_SCHEMA}"."User" tenant
           ON tenant.id = membership."userId"
         JOIN "${JARVIS_SCHEMA}"."Role" tenant_role
           ON tenant_role.id = membership."roleId"
         JOIN "${JARVIS_SCHEMA}"."Unit" unit
           ON unit.id = lease."unitId"
         JOIN "${JARVIS_SCHEMA}"."Property" property
           ON property.id = unit."propertyId"
        WHERE lease."startDate" <= ${NOW_UTC}
          AND lease."endDate"   >= ${NOW_UTC}
          AND ${DAYS_LEFT} = ANY($1::int[])
        ORDER BY lease."endDate" ASC`,
      // $2 is the zone `DAYS_LEFT` counts dates in; it reads it positionally.
      [periods, this.config.expiryScanTimeZone],
    );

    return rows.map(toExpiringLeaseDto);
  }

  /**
   * Everyone holding the Owner role in each of `organizationIds`.
   *
   * Mirrors jarvis's `getOwnerRecipients`: a notice about a lease goes to every
   * Owner, not to whichever one sorts first, and the role name is matched
   * case-insensitively because role names are free text that each organization
   * can edit.
   *
   * Owners without a phone number are returned rather than filtered out. This
   * service records them as `SKIPPED` reminders, so an owner nobody can reach
   * shows up as a row to fix instead of a silence.
   *
   * One query for every organization in the batch: a scan that finds eight
   * leases in one organization should not look its owners up eight times.
   */
  async findOwnerRecipients(
    organizationIds: string[],
  ): Promise<LeaseRecipient[]> {
    if (organizationIds.length === 0) return [];

    return this.leases.manager.query<LeaseRecipient[]>(
      `SELECT m.id              AS "membershipId",
              m."organizationId" AS "organizationId",
              u.name            AS "name",
              u.phone           AS "phone"
         FROM "${JARVIS_SCHEMA}"."Membership" m
         JOIN "${JARVIS_SCHEMA}"."User" u ON u.id = m."userId"
         JOIN "${JARVIS_SCHEMA}"."Role" r ON r.id = m."roleId"
        WHERE m."organizationId" = ANY($1)
          AND lower(btrim(r.name)) = $2
        ORDER BY m."createdAt"`,
      [organizationIds, OWNER_ROLE_NAME],
    );
  }
}

function toExpiringLeaseDto(row: ExpiringLeaseRow): ExpiringLeaseDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    membership: {
      id: row.membershipId,
      name: row.tenantName,
      phone: row.tenantPhone,
      role: row.roleName,
    },
    unit: {
      id: row.unitId,
      label: row.unitLabel,
      propertyName: row.propertyName,
    },
    startDate: row.startDate,
    endDate: row.endDate,
    daysLeft: row.daysLeft,
    durationMonths: row.durationMonths,
    monthlyRent: row.monthlyRent,
    leaseAmount: row.leaseAmount,
    renewedFromId: row.renewedFromId,
  };
}
