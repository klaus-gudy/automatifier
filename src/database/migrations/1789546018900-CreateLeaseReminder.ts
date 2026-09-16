import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `lease_reminder` in this service's own schema.
 *
 * **Hand-written, and every migration here has to be.** `migration:generate`
 * would diff jarvis's entire Prisma-owned `public` schema against this app's
 * deliberately partial entity mappings and emit `DROP COLUMN` for every column
 * not mapped — see the refusal wired into that npm script.
 *
 * The schema itself is not created here. It cannot be: `CREATE SCHEMA` needs
 * CREATE on the database, which the `automatifier` role does not have, and
 * TypeORM has already built its `migrations` table inside the schema by the
 * time this runs. It is a DBA step, recorded in TASK.md.
 *
 * The schema name is written out rather than imported from
 * `database/schema.ts`. A migration is a record of what was done to a
 * database on a particular day: if that constant is ever renamed, this file
 * must keep describing the table it actually created, and a *new* migration
 * moves it.
 */
export class CreateLeaseReminder1789546018900 implements MigrationInterface {
  name = 'CreateLeaseReminder1789546018900';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "automatifier"."lease_reminder" (
        "id"                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "lease_id"                text        NOT NULL,
        "lease_end_date"          timestamptz NOT NULL,
        "days_left"               integer     NOT NULL,
        "recipient_membership_id" text        NOT NULL,
        "recipient_name"          text,
        "recipient_phone"         text,
        "tenant_membership_id"    text        NOT NULL,
        "tenant_name"             text,
        "organization_id"         text        NOT NULL,
        "unit_id"                 text        NOT NULL,
        "unit_label"              text        NOT NULL,
        "property_name"           text        NOT NULL,
        "message"                 text        NOT NULL,
        "status"                  text        NOT NULL DEFAULT 'PENDING',
        "attempts"                integer     NOT NULL DEFAULT 0,
        "last_error"              text,
        "published_at"            timestamptz,
        "created_at"              timestamptz NOT NULL DEFAULT now(),
        "updated_at"              timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_lease_reminder_status"
          CHECK ("status" IN ('PENDING', 'PUBLISHED', 'SKIPPED', 'FAILED'))
      )
    `);

    /*
     * The de-duplication rule, in the database because that is the only place
     * two concurrent scans cannot both win. The scan inserts with ON CONFLICT
     * DO NOTHING and publishes only the rows it actually inserted.
     *
     * The recipient is part of the key: an organization can have several
     * Owners, and each is owed their own copy of the reminder.
     */
    await queryRunner.query(`
      ALTER TABLE "automatifier"."lease_reminder"
        ADD CONSTRAINT "uq_lease_reminder_lease_period_recipient"
        UNIQUE ("lease_id", "days_left", "lease_end_date", "recipient_membership_id")
    `);

    /*
     * Partial, because the sweeper only ever asks for what is still waiting.
     * A full index on `status` would be mostly PUBLISHED rows it never reads,
     * and would keep growing for the life of the service.
     */
    await queryRunner.query(`
      CREATE INDEX "idx_lease_reminder_pending"
        ON "automatifier"."lease_reminder" ("created_at")
        WHERE "status" = 'PENDING'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The constraints and index belong to the table and go with it.
    await queryRunner.query(`DROP TABLE "automatifier"."lease_reminder"`);
  }
}
