import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '@/app.module';
import { configureApp } from '@/configure-app';
import { HealthResponseDto } from '@/modules/health/dto/health-response.dto';

/**
 * **Needs the dependencies up** — `docker compose up -d` before running this.
 * The app opens a real connection pool at boot, so there is nothing to test
 * against without one, and mocking it out here would mean this test no longer
 * proves the thing it exists to prove: that the wiring in `AppModule` actually
 * connects.
 */
describe('Health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // The same configuration `main.ts` applies, so this exercises the app as
    // deployed rather than a differently-shaped one.
    configureApp(app);
    await app.init();
  });

  it('GET /health reports every dependency up', async () => {
    /*
     * Polled, not probed once. `RabbitmqService` starts its connection without
     * awaiting it on purpose, so the app serves HTTP while the broker is still
     * coming up — which means `/health` legitimately answers 503 for the first
     * moments of a process's life, and a single immediate call is a race this
     * test used to win only because the broker was switched off.
     */
    const response = await waitForHealthy();

    // A 503 here means a dependency is genuinely down, and the body says which.
    expect(response.status).toBe(200);

    // `response.body` is `any`; naming the shape once keeps the assertions
    // below type-checked against the DTO the controller actually returns.
    const body = response.body as HealthResponseDto;

    expect(body.status).toBe('ok');
    expect(body.checks.database.status).toBe('up');
    // "disabled" is a legitimate pass: RABBITMQ_ENABLED=false is a deliberate
    // configuration, not a broker that failed to answer.
    expect(['up', 'disabled']).toContain(body.checks.rabbitmq.status);
  });

  /**
   * Asks until every dependency answers, or gives up and returns the last
   * reply so the assertions can say which one never came up.
   */
  const waitForHealthy = async (attempts = 40) => {
    let response = await request(app.getHttpServer()).get('/health');

    for (let attempt = 1; attempt < attempts; attempt += 1) {
      if (response.status === 200) break;

      await new Promise((resolve) => setTimeout(resolve, 250));
      response = await request(app.getHttpServer()).get('/health');
    }

    return response;
  };

  it('serves health outside the API prefix', async () => {
    // The liveness probe must not move when API_PREFIX changes — a platform
    // polling it should not need to agree on an API version.
    await request(app.getHttpServer()).get('/api/v1/health').expect(404);
  });

  afterAll(async () => {
    await app.close();
  });
});
