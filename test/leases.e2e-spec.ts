import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';

import { AppModule } from '@/app.module';
import { configureApp } from '@/configure-app';

/** Dates arrive as ISO strings over HTTP, not `Date`s. */
interface ExpiringLeasesBody {
  windowDays: number;
  leases: { id: string; endDate: string; daysLeft: number }[];
}

/**
 * **Needs jarvis's database** — this reads real rows and asserts only what
 * must hold for any data, so it passes whether the window holds zero leases
 * or fifty.
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

  it('GET /api/v1/leases/expiring returns leases inside the 30-day window, soonest first', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/leases/expiring')
      .expect(200);

    const body = response.body as ExpiringLeasesBody;

    expect(body.windowDays).toBe(30);

    for (const lease of body.leases) {
      expect(lease.daysLeft).toBeGreaterThanOrEqual(0);
      expect(lease.daysLeft).toBeLessThanOrEqual(30);
    }

    const endDates = body.leases.map((lease) => lease.endDate);
    expect(endDates).toEqual([...endDates].sort());
  });

  it('returns end dates as the UTC values jarvis stored', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/leases/expiring')
      .expect(200);

    const [lease] = (response.body as ExpiringLeasesBody).leases;
    // Nothing in the window means nothing to compare, not a failure.
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
