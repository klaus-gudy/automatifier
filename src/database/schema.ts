/**
 * The two schemas this service touches, and the different rights it has in each.
 *
 * Deliberately constants rather than configuration. They are not deployment
 * knobs with a sensible range of values — they are the shape of the agreement
 * with jarvis, and each has exactly one correct value. A `DATABASE_SCHEMA`
 * variable would let an environment move `lease_reminder` somewhere while
 * `Lease` stayed put, which is a half-working service rather than a
 * configuration.
 */

/**
 * jarvis's schema, owned by its Prisma migrations. This service holds SELECT
 * here and no write grant at all, so every entity mapped into it is read-only
 * by permission as well as by intent.
 */
export const JARVIS_SCHEMA = 'public';

/**
 * This service's own schema, in the same database. It owns this one outright —
 * tables, migrations, writes.
 *
 * It must already exist: `CREATE SCHEMA` needs CREATE on the database, which
 * the `automatifier` role does not have, and TypeORM will not create it either
 * (it builds its `migrations` table *inside* this schema and fails if it is
 * missing). Created once as a DBA step, recorded in TASK.md.
 */
export const AUTOMATIFIER_SCHEMA = 'automatifier';
