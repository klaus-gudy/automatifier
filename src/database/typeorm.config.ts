import { types } from 'pg';
import { DataSourceOptions } from 'typeorm';

import { AUTOMATIFIER_SCHEMA } from '@/database/schema';

/*
 * jarvis stores every timestamp as UTC in `timestamp without time zone`. By
 * default `pg` parses that type as *local* time, so on a machine at +03:00 a
 * lease ending at midnight UTC comes back as 21:00 the day before — every date
 * off by the process's UTC offset, and by a different amount on a server that
 * runs in UTC, which is what makes it hard to notice.
 *
 * Appending `Z` makes the value parse as the UTC it actually is. Set here,
 * at module load, because this file is imported by both the Nest runtime and
 * the TypeORM CLI. `types` is process-global in `pg`, so this applies to every
 * pool in the process — correct for as long as every zone-less timestamp this
 * service reads is UTC.
 *
 * Reads only. Writing a `Date` into such a column would still be serialised in
 * local time; that needs its own fix before this service writes one.
 */
types.setTypeParser(
  types.builtins.TIMESTAMP,
  (value) => new Date(`${value.replace(' ', 'T')}Z`),
);

export interface DatabaseSettings {
  url: string;
  host: string;
  port: number;
  username: string;
  password: string;
  name: string;
  migrationsRun: boolean;
  logging: boolean;
}

/**
 * Single source of truth for connection options, shared by the Nest runtime and
 * the TypeORM CLI so migrations always run against the same schema definition.
 */
export const buildDataSourceOptions = (
  db: DatabaseSettings,
): DataSourceOptions => {
  const shared = {
    type: 'postgres' as const,
    entities: [__dirname + '/../**/*.entity{.ts,.js}'],
    migrations: [__dirname + '/migrations/*{.ts,.js}'],
    /*
     * Present here for one reason: TypeORM decides where its own `migrations`
     * table goes from the *data source*, not from any entity
     * (`MigrationExecutor` reads `dataSource.driver.options.schema`). Left
     * unset it would try to create that table in `public`, which is jarvis's
     * and which this role cannot write to.
     *
     * It is not what places the entities. Each of those declares its own schema
     * — `Lease` reads `public`, `LeaseReminder` owns its table here — because
     * TypeORM qualifies every table name rather than setting `search_path`, so
     * nothing falls back to a search order.
     */
    schema: AUTOMATIFIER_SCHEMA,
    /*
     * Schema changes go through migrations only. `synchronize: true` reads as
     * a convenience and behaves as a data-loss bug the first time a column is
     * renamed — TypeORM drops the old one to make the schema match.
     */
    synchronize: false,
    migrationsRun: db.migrationsRun,
    logging: db.logging,
  };

  // A connection string wins when set. The discrete fields stay as the
  // fallback so a local .env keeps working untouched.
  return db.url
    ? { ...shared, url: db.url }
    : {
        ...shared,
        host: db.host,
        port: db.port,
        username: db.username,
        // Empty string is not a password, it is an unset variable — passing it
        // through makes `pg` send an empty credential instead of using peer
        // or trust auth.
        password: db.password || undefined,
        database: db.name,
      };
};
