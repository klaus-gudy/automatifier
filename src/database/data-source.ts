import 'dotenv/config';
import { DataSource } from 'typeorm';

import databaseConfig from '../config/database.config';
import { buildDataSourceOptions } from './typeorm.config';

/**
 * Entry point for the TypeORM CLI (`npm run migration:*`).
 *
 * Two deliberate differences from every other file here:
 *
 * `dotenv/config` at the top, because the CLI runs outside Nest — there is no
 * `ConfigModule` to read `.env`, so without it every variable below is
 * undefined and migrations run against the defaults.
 *
 * Relative imports rather than the `@/` alias, because `ts-node` resolves
 * neither `paths` nor this file through Nest's build. An alias here fails at
 * `migration:run` with a bare module-not-found.
 */
export default new DataSource(buildDataSourceOptions(databaseConfig()));
