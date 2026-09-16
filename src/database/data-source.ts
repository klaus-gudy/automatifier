import 'dotenv/config';
import { DataSource } from 'typeorm';

import databaseConfig from '@/config/database.config';
import { buildDataSourceOptions } from '@/database/typeorm.config';

/**
 * Entry point for the TypeORM CLI (`npm run migration:*`).
 *
 * One deliberate difference from every other file here: `dotenv/config` at the
 * top, because the CLI runs outside Nest — there is no `ConfigModule` to read
 * `.env`, so without it every variable below is undefined and migrations run
 * against the defaults.
 *
 * The `@/` alias works here only because the `typeorm` script registers
 * `tsconfig-paths` alongside `ts-node`. It did not always: this file and
 * everything the CLI loads through the entity glob used relative imports
 * instead, until an entity needed a shared constant and the rule became a trap
 * that fires at `migration:run` with a bare module-not-found. Keep the
 * `-r tsconfig-paths/register` in that script and the alias keeps working
 * everywhere.
 */
export default new DataSource(buildDataSourceOptions(databaseConfig()));
