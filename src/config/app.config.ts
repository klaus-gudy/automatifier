import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  env: process.env.NODE_ENV ?? 'development',

  port: Number(process.env.PORT ?? 3000),

  /**
   * Prefixed onto every HTTP route except `health` — see `configure-app.ts`. A
   * platform's liveness probe should not need to know or agree on an API
   * version to find it, so it stays reachable at bare `/health` regardless.
   */
  apiPrefix: process.env.API_PREFIX ?? 'api/v1',

  /**
   * Whether to serve the OpenAPI docs.
   *
   * Off in production unless asked for: the document describes the shape of
   * everything the service accepts, which is a convenience on an internal
   * network and a free map on a public one.
   */
  swaggerEnabled:
    process.env.SWAGGER_ENABLED === 'true' ||
    (process.env.SWAGGER_ENABLED !== 'false' &&
      process.env.NODE_ENV !== 'production'),

  /**
   * Logs full request bodies to the terminal. Off by default — a body is the
   * most likely place for something that should not be in a log, and the
   * redaction in `log-format.ts` only catches keys it knows the names of.
   */
  logRequestBody: process.env.LOG_REQUEST_BODY === 'true',
}));
