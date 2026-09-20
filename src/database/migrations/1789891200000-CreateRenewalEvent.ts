import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `renewal_event` in this service's own schema — the outbox behind
 * `lease.renewal` and `lease.vacating`.
 *
 * Hand-written, like every migration here, and for the same reason:
 * `migration:generate` would diff jarvis's Prisma-owned `public` schema
 * against this app's partial entity mappings and emit `DROP COLUMN` for
 * everything not mapped.
 *
 * The schema name is written out rather than imported, so this file keeps
 * describing the table it actually created even if that constant is renamed.
 */
export class CreateRenewalEvent1789891200000 implements MigrationInterface {
  name = 'CreateRenewalEvent1789891200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "automatifier"."renewal_event" (
        "id"                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "lease_id"             text        NOT NULL,
        "kind"                 text        NOT NULL,
        "lease_end_date"       timestamptz NOT NULL,
        "days_overdue"         integer     NOT NULL,
        "organization_id"      text        NOT NULL,
        "tenant_membership_id" text        NOT NULL,
        "tenant_name"          text,
        "unit_id"              text        NOT NULL,
        "unit_label"           text        NOT NULL,
        "property_name"        text        NOT NULL,
        "payload"              jsonb       NOT NULL,
        "status"               text        NOT NULL DEFAULT 'PENDING',
        "attempts"             integer     NOT NULL DEFAULT 0,
        "last_error"           text,
        "published_at"         timestamptz,
        "created_at"           timestamptz NOT NULL DEFAULT now(),
        "updated_at"           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_renewal_event_kind"
          CHECK ("kind" IN ('RENEWAL', 'VACATING')),
        CONSTRAINT "chk_renewal_event_status"
          CHECK ("status" IN ('PENDING', 'PUBLISHED', 'FAILED'))
      )
    `);

    /*
     * What makes the daily scan publish a lease once instead of every morning
     * it is still overdue. In the database, because two scans running at once
     * cannot both win here — the scan inserts ON CONFLICT DO NOTHING and
     * publishes only what it inserted.
     */
    await queryRunner.query(`
      ALTER TABLE "automatifier"."renewal_event"
        ADD CONSTRAINT "uq_renewal_event_lease_kind_end_date"
        UNIQUE ("lease_id", "kind", "lease_end_date")
    `);

    /* Partial, because the sweeper only ever asks for what is still waiting. */
    await queryRunner.query(`
      CREATE INDEX "idx_renewal_event_pending"
        ON "automatifier"."renewal_event" ("created_at")
        WHERE "status" = 'PENDING'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "automatifier"."renewal_event"`);
  }
}
