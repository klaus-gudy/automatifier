import { registerAs } from '@nestjs/config';

/**
 * Postgres connection settings, as a namespaced config factory.
 *
 * Both forms are supported deliberately: a platform that injects one
 * `DATABASE_URL` (Render, Heroku, a Docker secret) and a local `.env` that
 * spells the parts out are both normal, and supporting only one means the
 * other environment needs a wrapper script to translate.
 */
export default registerAs('database', () => ({
  /** Full connection string. Takes precedence over the discrete fields. */
  url: process.env.DATABASE_URL ?? '',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5432),
  username: process.env.DATABASE_USER ?? 'postgres',
  password: process.env.DATABASE_PASSWORD ?? '',
  name: process.env.DATABASE_NAME ?? 'automatifier',

  /**
   * Runs pending migrations at boot.
   *
   * Fine while this is a single process. The moment it runs more than one
   * replica, two instances starting together race on the same migration —
   * turn this off and run `npm run migration:run` as a deploy step instead.
   */
  migrationsRun: process.env.DATABASE_MIGRATIONS_RUN !== 'false',

  /**
   * Verbatim SQL in the terminal. Off by default: it is genuinely useful when
   * a query is behaving oddly and completely unreadable the rest of the time.
   */
  logging: process.env.DATABASE_LOGGING === 'true',
}));
