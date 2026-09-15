import { registerAs } from '@nestjs/config';

// Relative, not `@/config/env`: this file is also loaded by the TypeORM CLI
// through `data-source.ts`, where `ts-node` does not resolve the alias.
import { booleanEnv } from './env';

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
   * Runs pending migrations at boot. **Off unless set to `true`.**
   *
   * This used to default on (`!== 'false'`), which made a blank
   * `DATABASE_MIGRATIONS_RUN=` mean "run". That was harmless against a
   * database this service owns and is wrong against jarvis's: its schema
   * belongs to Prisma, and TypeORM's first act when running migrations is to
   * create its own `migrations` table there — a write into another app's
   * schema, or a boot crash under the read-only role. Opting in is the safe
   * direction to get wrong.
   *
   * Even when this does own a database: fine for a single process only. With
   * more than one replica, two instances starting together race on the same
   * migration — leave this off and run `npm run migration:run` as a deploy
   * step instead.
   */
  migrationsRun: booleanEnv('DATABASE_MIGRATIONS_RUN', false),

  /**
   * Verbatim SQL in the terminal. Off by default: it is genuinely useful when
   * a query is behaving oddly and completely unreadable the rest of the time.
   */
  logging: booleanEnv('DATABASE_LOGGING', false),
}));
