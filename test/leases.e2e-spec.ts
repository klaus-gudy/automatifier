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
  leases: { id: string; endDate: string; daysLeft: number }[];
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

  afterAll(async () => {
    await app.close();
  });
});
