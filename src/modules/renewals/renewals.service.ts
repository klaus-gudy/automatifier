import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import leaseConfig from '@/config/lease.config';
import { JARVIS_SCHEMA } from '@/database/schema';
import { Lease } from '@/modules/leases/lease.entity';
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
   * Leases whose `endDate` has passed but that are still "live" — nothing has
   * renewed them.
   *
   * jarvis's `Lease` has no status column: a lease is superseded only when
   * another lease points back at it through `renewedFromId`. So "ended and
   * still active" is `endDate < now` with no successor. Without the
   * `NOT EXISTS`, every lease that was ever renewed would be listed forever.
   *
   * Raw SQL for the same reason as `LeasesService.findExpiring`: TypeORM cannot
   * join schema-qualified tables it has no entity for.
   */
  async findOverdue(): Promise<OverdueRenewalLeaseDto[]> {
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
        WHERE lease."endDate" < ${NOW_UTC}
          AND NOT EXISTS (
                SELECT 1
                  FROM "${JARVIS_SCHEMA}"."Lease" successor
                 WHERE successor."renewedFromId" = lease.id
              )
        ORDER BY lease."endDate" ASC`,
      [this.config.expiryScanTimeZone],
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
    startDate: row.startDate,
    endDate: row.endDate,
    daysOverdue: row.daysOverdue,
    durationMonths: row.durationMonths,
    monthlyRent: row.monthlyRent,
    leaseAmount: row.leaseAmount,
    renewedFromId: row.renewedFromId,
  };
}
