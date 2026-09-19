import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import leaseConfig from '@/config/lease.config';
import { JARVIS_SCHEMA } from '@/database/schema';
import { Lease, type LeaseStatus } from '@/modules/leases/lease.entity';
import { OverdueRenewalLeaseDto } from '@/modules/renewals/dto/overdue-renewals-response.dto';

/** See `NOW_UTC` in `leases.service.ts` for why "now" comes from SQL. */
const NOW_UTC = `(now() AT TIME ZONE 'UTC')`;

/**
 * Calendar days since the lease ended, in the reminder time zone (`$1`) —
 * `DAYS_LEFT` in `leases.service.ts` with the operands swapped, so the two
 * endpoints never disagree about which day a lease ended on.
 */
const DAYS_OVERDUE = `(
        (now() AT TIME ZONE $1)::date
      - (lease."endDate" AT TIME ZONE 'UTC' AT TIME ZONE $1)::date
      )`;

const ACTIVE: LeaseStatus = 'Active';

interface OverdueRenewalRow {
  id: string;
  unitId: string;
  membershipId: string;
  startDate: Date;
  endDate: Date;
  durationMonths: number;
  monthlyRent: number;
  leaseAmount: number;
  renewedFromId: string | null;
  daysOverdue: number;
  organizationId: string;
  tenantName: string | null;
  tenantPhone: string | null;
  roleName: string;
  unitLabel: string;
  propertyName: string;
  autoRenew: boolean;
}

@Injectable()
export class RenewalsService {
  constructor(
    @InjectRepository(Lease)
    private readonly leases: Repository<Lease>,
    @Inject(leaseConfig.KEY)
    private readonly config: ConfigType<typeof leaseConfig>,
  ) {}

  /**
   * Leases jarvis still marks `Active` although their `endDate` has passed —
   * the ones waiting on a renewal decision.
   *
   * Keyed on jarvis's `status` rather than inferred from `renewedFromId`: a
   * renewed lease is `Renewed`, a closed one `Ended`, so neither needs a
   * separate exclusion, and this agrees with what jarvis's own screens show.
   *
   * Raw SQL for the same reason as `LeasesService.findExpiring`: TypeORM cannot
   * join schema-qualified tables it has no entity for.
   */
  findOverdue(): Promise<OverdueRenewalLeaseDto[]> {
    return this.findActivePastEnd(false);
  }

  /**
   * The subset of `findOverdue` whose unit has `autoRenew` on — the leases
   * jarvis's auto-renewal should already have picked up, or still has to.
   *
   * The flag lives on jarvis's `Unit`, not the `Lease`: it is a standing
   * choice for whoever rents the unit, so it is read at query time rather than
   * copied onto the lease.
   */
  findDueForAutoRenewal(): Promise<OverdueRenewalLeaseDto[]> {
    return this.findActivePastEnd(true);
  }

  /**
   * One query behind both endpoints, so "active and past its end" cannot
   * drift between them. `$3` is `true` to require `autoRenew`, `false` to
   * ignore it.
   */
  private async findActivePastEnd(
    autoRenewOnly: boolean,
  ): Promise<OverdueRenewalLeaseDto[]> {
    const rows = await this.leases.manager.query<OverdueRenewalRow[]>(
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
              unit."autoRenew"            AS "autoRenew",
              ${DAYS_OVERDUE}             AS "daysOverdue"
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
        WHERE lease.status    = $2
          AND lease."endDate" < ${NOW_UTC}
          AND (NOT $3 OR unit."autoRenew")
        ORDER BY lease."endDate" ASC`,
      [this.config.expiryScanTimeZone, ACTIVE, autoRenewOnly],
    );

    return rows.map(toOverdueRenewalLeaseDto);
  }
}

function toOverdueRenewalLeaseDto(
  row: OverdueRenewalRow,
): OverdueRenewalLeaseDto {
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
    autoRenew: row.autoRenew,
    startDate: row.startDate,
    endDate: row.endDate,
    daysOverdue: row.daysOverdue,
    durationMonths: row.durationMonths,
    monthlyRent: row.monthlyRent,
    leaseAmount: row.leaseAmount,
    renewedFromId: row.renewedFromId,
  };
}
