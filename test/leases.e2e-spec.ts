import { INestApplication } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';

import leaseConfig from '@/config/lease.config';
import { AppModule } from '@/app.module';
import { configureApp } from '@/configure-app';

/** Dates arrive as ISO strings over HTTP, not `Date`s. */
interface ExpiringLeasesBody {
  windowDays: number[];
  leases: {
    id: string;
    endDate: string;
    daysLeft: number;
    organizationId: string;
    membership: {
      id: string;
      name: string | null;
      phone: string | null;
      role: string;
    };
    unit: { id: string; label: string; propertyName: string };
  }[];
}

/**
 * **Needs jarvis's database** — this reads real rows and asserts only what
 * must hold for any data, so it passes whether nothing matches or fifty leases
 * do.
 */
describe('Leases (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  const fetchExpiring = async (): Promise<ExpiringLeasesBody> => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/leases/expiring')
      .expect(200);
    return response.body as ExpiringLeasesBody;
  };

  it('echoes the configured LEASE_EXPIRY_DAYS as windowDays, furthest first', async () => {
    const { expiryDays } = app.get<ConfigType<typeof leaseConfig>>(
      leaseConfig.KEY,
    );

    const body = await fetchExpiring();

    // Taken from the running config rather than hard-coded, so this checks the
    // wiring from LEASE_EXPIRY_DAYS without breaking whenever .env changes.
    expect(body.windowDays).toEqual(expiryDays);
  });

  it('lists only leases whose days left is one of windowDays, soonest first', async () => {
    const body = await fetchExpiring();

    for (const lease of body.leases) {
      expect(body.windowDays).toContain(lease.daysLeft);
    }

    const endDates = body.leases.map((lease) => lease.endDate);
    expect(endDates).toEqual([...endDates].sort());
  });

  it('includes every active lease that has exactly one of windowDays left', async () => {
    const body = await fetchExpiring();

    /*
     * The assertions above hold just as well for an empty `leases` — which is
     * exactly what a broken join between the computed `daysLeft` and the
     * entities would produce. So select the same thing independently, in plain
     * SQL, and require the ids to match.
     */
    const rows = await app.get(DataSource).query<{ id: string }[]>(
      `SELECT id FROM "Lease"
        WHERE "startDate" <= (now() AT TIME ZONE 'UTC')
          AND "endDate" >= (now() AT TIME ZONE 'UTC')
          AND floor(extract(epoch FROM "endDate" - (now() AT TIME ZONE 'UTC')) / 86400) = ANY($1::int[])`,
      [body.windowDays],
    );

    expect(body.leases.map((lease) => lease.id).sort()).toEqual(
      rows.map((row) => row.id).sort(),
    );
  });

  it('carries the tenant and unit each reminder has to name', async () => {
    const body = await fetchExpiring();
    const [lease] = body.leases;
    // Nothing due today is not a failure; there is simply nothing to check.
    if (!lease) return;

    /*
     * The message needs all five of these — "Habari {owner}, Mkataba wa
     * {tenant}, mpangaji wa {property} - Unit {unit}…" — and the owner is
     * looked up from `organizationId`, not taken off the lease.
     */
    expect(typeof lease.organizationId).toBe('string');
    expect(typeof lease.membership.id).toBe('string');
    expect(typeof lease.membership.role).toBe('string');
    expect(typeof lease.unit.label).toBe('string');
    expect(typeof lease.unit.propertyName).toBe('string');

    // The lease on a tenant's membership: anything else means the join walked
    // to the wrong membership and the message would name the wrong person.
    const [row] = await app.get(DataSource).query<{ role: string }[]>(
      `SELECT r.name AS role
         FROM "Lease" l
         JOIN "Membership" m ON m.id = l."membershipId"
         JOIN "Role" r ON r.id = m."roleId"
        WHERE l.id = $1`,
      [lease.id],
    );

    expect(lease.membership.role).toBe(row.role);
  });

  it('returns end dates as the UTC values jarvis stored', async () => {
    const [lease] = (await fetchExpiring()).leases;
    // Nothing matching means nothing to compare, not a failure.
    if (!lease) return;

    /*
     * Postgres formats the stored value itself, bypassing `pg`'s parser
     * entirely. If the OID 1114 parser in `typeorm.config.ts` is lost, the API
     * value shifts by the machine's UTC offset and this stops matching — on a
     * machine running in UTC it would still pass, which is exactly why the
     * parser is easy to lose.
     */
    const [row] = await app.get(DataSource).query<{ endDate: string }[]>(
      `SELECT to_char("endDate", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endDate"
         FROM "Lease" WHERE id = $1`,
      [lease.id],
    );

    expect(lease.endDate).toBe(row.endDate);
  });

  it('POST /api/v1/leases/expiring/scan runs the scan now and returns what GET returns', async () => {
    const before = Date.now();

    const response = await request(app.getHttpServer())
      .post('/api/v1/leases/expiring/scan')
      // 200, not POST's default 201: a scan creates nothing.
      .expect(200);

    const scan = response.body as ExpiringLeasesBody & {
      trigger: string;
      scannedAt: string;
      nextScheduledRunAt: string;
      reminders: { created: number; duplicates: number; skipped: number };
    };
    const listed = await fetchExpiring();

    expect(scan.trigger).toBe('manual');
    expect(scan.windowDays).toEqual(listed.windowDays);
    // Same query, same moment (to within a request), same leases — the scan is
    // the endpoint's logic on a timer, not a second definition of "expiring".
    expect(scan.leases.map((lease) => lease.id)).toEqual(
      listed.leases.map((lease) => lease.id),
    );
    expect(new Date(scan.scannedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(scan.nextScheduledRunAt).getTime()).toBeGreaterThan(
      new Date(scan.scannedAt).getTime(),
    );

    /*
     * Every lease found is accounted for in the outbox — as a row written now,
     * one already there from an earlier scan, or one skipped for want of a
     * phone number. A lease that matched but produced no reminder at all would
     * be a reminder nobody ever receives, which is the failure this whole
     * table exists to prevent.
     *
     * Greater-than-or-equal because an organization can have several Owners,
     * and each is owed a copy.
     */
    const { created, duplicates, skipped } = scan.reminders;
    expect(created + duplicates + skipped).toBeGreaterThanOrEqual(
      scan.leases.length,
    );
  });

  it('records nothing new when the same scan runs twice', async () => {
    // Whatever the first call found is now recorded, so the second must write
    // nothing — the de-duplication that stops an owner being texted twice.
    await request(app.getHttpServer())
      .post('/api/v1/leases/expiring/scan')
      .expect(200);

    const response = await request(app.getHttpServer())
      .post('/api/v1/leases/expiring/scan')
      .expect(200);

    const { reminders } = response.body as {
      reminders: { created: number; skipped: number };
    };

    expect(reminders.created).toBe(0);
    expect(reminders.skipped).toBe(0);
  });

  afterAll(async () => {
    await app.close();
  });
});
