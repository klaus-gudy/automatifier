import { DataSourceOptions } from 'typeorm';

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
