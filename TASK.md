# Tasks

A running record of what changes in this repo and what is still open. Newest
entries first. `README.md` describes how to run the service and is not updated
as part of feature work.

## Open

- [ ] **Hide credentials from the `automatifier` role (optional).** It can read
      the whole `public` schema, including `User.passwordHash`,
      `EmailVerificationToken` and `PasswordResetToken`. Nothing here needs
      them; revoking them needs a column-level grant on `User`.
- [ ] **`.env.example` line 3 reads `API_PREFIX` with no `=`.** Predates this
      log; left untouched.
- [ ] **Writing dates into jarvis's `timestamp` columns is not handled.** The
      UTC fix covers reads only. Needed before this service writes a date.
- [ ] **`redact()` logs every `Date` as `{}`.** `common/logging/log-format.ts`
      rebuilds objects via `Object.entries`, which is empty for a `Date`
      (its fields are non-enumerable getters). Every lease's `startDate` and
      `endDate` show as `{}` in the request/response log, though the real
      value is still returned in the HTTP response itself. Pre-existing, found
      while checking `MAX_PAYLOAD_CHARS`.
- [ ] **Scan runs once per process.** Two replicas would each scan at 08:00.
      Harmless while it only logs; needs a lock or a single scheduler instance
      before the scan sends anything.
- [ ] **A `prisma migrate reset` in jarvis becomes a shared-fate event** once
      the reminder table lives in that database. Prisma manages `public` only,
      and `prisma migrate deploy` (jarvis's only migration script) leaves a
      sibling schema alone — but anything that drops and recreates the database
      takes `automatifier.lease_reminder` with it.
- [ ] **Next increment** — the plan below.

## Plan: lease reminders (agreed 2026-09-16; steps 1-4 and 6 done)

The 08:00 scan records each reminder in a table it owns, then publishes an SMS
event. The table is not bookkeeping for its own sake: periods match *exactly*
24 and 1 days left, so a broker outage at 08:00 loses that day's reminders
permanently — tomorrow the lease is at 23 days and matches nothing. It is an
outbox first, a dedupe ledger second (nothing downstream dedupes: notifier's
audit table has no idempotency key, and `POST /leases/expiring/scan` makes
double-sending one click away).

Decisions taken:

- **Where:** an `automatifier` schema inside jarvis's database, one connection.
  (The alternative — automatifier's own DB on 5440 — was not chosen; that
  container stays unused.)
- **Broker:** jarvis's, `localhost:5682`, where notifier already listens.
  Automatifier's `.env` currently points at 5683 with `RABBITMQ_ENABLED=false`.
- **Transport:** publish to `NOTIFIER_SMS_QUEUE`, declared and bound by
  automatifier (producer owns the queue, as jarvis does for mail — notifier
  only `checkQueue`s). Notifier gains an SMS consumer mirroring its email one.

Steps, in order:

1. [x] **Done 2026-09-16.** DBA step (user ran): `automatifier` schema created
       and owned by the role, `default_transaction_read_only` reset. Verified:
       it can create and drop a table in its own schema, while
       `UPDATE "Lease"` fails with *permission denied for table Lease* — the
       grants, not the session flag, are what keep jarvis's tables unwritable.
2. [x] **Done 2026-09-16.** `lease_reminder` entity + hand-written migration;
       `DATABASE_SCHEMA` (default `automatifier`) on the data source, explicit
       `schema: 'public'` on the `Lease` entity. Verified after
       `migration:run`: the `automatifier` schema holds `lease_reminder` and
       TypeORM's `migrations`, `public` still has its original 20 tables, and
       the expiring endpoint still returns real jarvis rows.
3. [x] **Done 2026-09-16.** Scan inserts `PENDING` rows with `ON CONFLICT DO
       NOTHING` and publishes nothing. Verified against real data: first scan
       wrote 3 rows, second wrote 0 and reported 3 duplicates.
4. [x] **Done 2026-09-16.** Publishing to jarvis's broker, `PUBLISHED` on
       confirm. Verified by reading the queue: three messages, correct
       payloads, `persistent`, routing key `lease.expiring`.
5. [ ] SMS consumer in notifier. **Deliberately not started** — until it
       exists, reminders accumulate in `NOTIFIER_SMS_QUEUE`, which is durable,
       so nothing is lost and nothing is delivered.
6. [x] **Done 2026-09-16.** Sweeper retries `PENDING` rows every ten minutes.
       Verified by resetting a row to `PENDING` with a window matching no
       lease: only the sweeper could have published it, and it did.

Table shape: `lease_id`, `lease_end_date`, `days_left`, snapshots of
`recipient_phone` / `recipient_name` / `organization_id` / `unit_id`, the
rendered `message`, `status` (`PENDING` → `PUBLISHED` | `SKIPPED` | `FAILED`),
`attempts`, `last_error`, `published_at`. Unique on
`(lease_id, days_left, lease_end_date, recipient_membership_id)` — the end date
is in the key because an edited end date can legitimately reach 24 days again,
and the recipient because an organization can have several Owners, each owed
their own copy.

Two things that will bite if forgotten:

- **Never run `migration:generate`** against this database. It would diff
  Prisma's schema against the partial `Lease` mapping and emit drops for every
  column not mapped. Hand-written `migration:create` only.
- **Phone format.** jarvis stores `0783468181`; notifier's
  `stripPhoneFormatting` only removes spaces, dashes, brackets and `+`, so it
  never converts the leading `0` to `255`. Automatifier must normalize before
  publishing, and the snapshot records what was actually sent.

## Log

### 2026-09-18 — `renewals` module: overdue renewals endpoint (uncommitted)

- `GET /renewals/overdue`: leases whose `endDate` has passed and that no
  other lease renews (`renewedFromId`), with tenant, unit and `daysOverdue`
  (calendar days in `LEASE_EXPIRY_SCAN_TIMEZONE`), longest overdue first.
- jarvis's `Lease` has no status column, so "still active" means "has no
  successor".

### 2026-09-18 — Calendar day counting, and a "kesho" message (uncommitted)

- **`daysLeft` now counts calendar days in the reminder time zone**, not
  elapsed time rounded down. On 18 September at 11:57 EAT a lease ending
  2026-09-20 had 39 hours left, which the old `floor((endDate - now) / 1 day)`
  called **1 day** and everyone else calls 2. Every count moves up by one, and
  `LEASE_EXPIRY_DAYS=24,1` now means what it reads as: 24 calendar days, and
  tomorrow.
- **This disagrees with jarvis's screens by a day**, which previously matched on
  purpose. Accepted: the number in a text has to match the reader's calendar.
  It also removes the old oddity where every count dropped at 03:00 EAT rather
  than at midnight.
- The SQL converts twice — `AT TIME ZONE 'UTC' AT TIME ZONE $2` — because
  jarvis's end dates are zone-less timestamps holding UTC. Casting straight to
  a date would be a day early for every lease after 21:00 local.
- **New message shapes at 1 and 0 days**, which is what calendar counting makes
  possible:
  - `… unamalizika kesho, tarehe 20 September 2026. Tafadhali mpigie simu
    Florencia kwa namba +255685185247.`
  - `… unamalizika leo, tarehe …` with the same request.
  A day out, the owner has to act rather than note, so the message carries the
  tenant's number, normalised to international form and dropped entirely when
  there is none — "kwa namba null" helps nobody.

### 2026-09-16 — Publishing + sweeper (uncommitted)

- Reminders are published to jarvis's broker (`localhost:5682`) on
  `automatifier.events` with routing key `lease.expiring`, payload exactly
  notifier's `SendSmsDto` plus `lease_id` / `reminder_id` for tracing.
  `.env` now has `RABBITMQ_ENABLED=true` and the 5682 URL.
- **`NOTIFIER_SMS_QUEUE` already existed**, declared by jarvis against
  `jarvis.sms.dlx` and bound `#` to a `jarvis.sms` exchange. The planned
  "producer declares the queue" was therefore wrong: asserting it here with a
  different dead-letter exchange is refused with `PRECONDITION_FAILED`, which
  closed the channel and left the connection retrying in a loop.
  `RabbitmqService.bindConsumerQueue` now only *binds* the existing queue to
  this service's exchange. One queue, two producers.
- `LeaseReminderSweeperService` retries `PENDING` rows on
  `LEASE_REMINDER_SWEEP_CRON` (default every ten minutes), giving up to
  `FAILED` after `LEASE_REMINDER_MAX_ATTEMPTS`.
- Rows are claimed with `UPDATE … FOR UPDATE SKIP LOCKED`, so a scan and a
  sweep running together take different rows. Delivery is **at least once**: a
  process dying between the broker's confirm and the `PUBLISHED` update
  republishes that row later.

Three bugs found by running it, all fixed:

- **Blank env values were not defaults.** `EVENT_EXCHANGE=` resolved to the
  AMQP *default exchange*, which no client may declare — the broker refused and
  the unhandled channel error killed the process. `??` only falls back on
  `undefined`. `stringEnv` / `numberEnv` in `config/env.ts` now treat blank as
  unset everywhere, which also fixes a blank `PORT=` binding a random port and
  a blank `RABBITMQ_PREFETCH=` meaning unlimited.
- **A channel error killed the app.** `ChannelWrapper` is an EventEmitter, and
  an unhandled `error` event throws. Now logged; the library reopens the
  channel and replays every `addSetup`.
- **`UPDATE … RETURNING` comes back as `[rows, rowCount]`**, not rows, unlike a
  SELECT through the same method. The claim loop iterated the array and the
  count, publishing two messages whose every field was `undefined` —
  `JSON.stringify` simply dropped them. Fixed, and the publish path now refuses
  any reminder missing an id, phone or message.

Also: a publish is bounded by a 10s timeout. `amqp-connection-manager` buffers
a publish made while disconnected and settles only on confirm, so an HTTP-
triggered scan hung for minutes with the broker unreachable instead of failing.

### 2026-09-16 — Reminders recorded, enriched lease query (uncommitted)

- `GET /api/v1/leases/expiring` now carries what a message has to name:
  `membership` (id, name, phone, role) and `unit` (id, label, propertyName),
  plus `organizationId`.
- **Recipients are Owners, not tenants.** The agreed message greets one person
  and describes another — and jarvis's own `announceLeaseRenewals` sends lease
  notices to `getOwnerRecipients(organizationId)`. `LeasesService.findOwnerRecipients`
  mirrors it, matching the role name case-insensitively because role names are
  editable free text. One reminder per Owner, so the unique key gained
  `recipient_membership_id` — an organization with two Owners owes two texts.
- `LeaseReminderService.recordFor` writes one row per (lease, period, Owner)
  with `ON CONFLICT DO NOTHING` and reports `{ created, duplicates, skipped }`,
  which the scan logs and returns. Publishing is still step 4.
- Phone numbers are normalised to `255…` in `common/phone.ts` before storage.
  An owner whose number cannot be normalised gets a `SKIPPED` row carrying the
  reason, not silence. One real row in jarvis (`476978247`) exercises this.
- The message is rendered in `lease-reminder.message.ts` and stored on the row
  as sent, in the scan's configured time zone.
- `findExpiring` is now one raw SQL statement. The query builder cannot join a
  schema-qualified table — TypeORM splits `"public"."Membership"` on the dot
  and reads `"public"` as an alias — and mapping `Membership`, `User`, `Role`,
  `Unit` and `Property` as entities would put five more Prisma-owned tables
  under this service's maintenance for six scalar columns.

### 2026-09-16 — `lease_reminder` table, in its own schema (uncommitted)

- `LeaseReminder` entity + hand-written migration
  `1789546018900-CreateLeaseReminder`, creating
  `automatifier.lease_reminder`: the lease reference by value, snapshots of
  recipient/org/unit, the rendered `message`, `status`, `attempts`,
  `last_error`, `published_at`.
- `status` is `text` with a CHECK rather than a Postgres enum (notifier uses an
  enum): the list will grow, and widening a CHECK is one migration where
  `ALTER TYPE ... ADD VALUE` cannot be used in the transaction that references
  the new value.
- Unique on `(lease_id, days_left, lease_end_date)` — the de-dupe gate, in the
  database because two concurrent scans would both pass an application-level
  check. Partial index on `created_at WHERE status = 'PENDING'` for the
  sweeper.
- Schema names are **constants in `src/database/schema.ts`**, not
  configuration: `JARVIS_SCHEMA` (read-only, SELECT and no write grant) and
  `AUTOMATIFIER_SCHEMA` (owned outright). Each entity declares its own — a
  `DATABASE_SCHEMA` variable was tried first and dropped, since it would let an
  environment move `lease_reminder` while `Lease` stayed put. The data source
  still sets `schema` for one reason only: TypeORM reads
  `dataSource.driver.options.schema` to decide where its `migrations` table
  goes, and no entity can tell it that.
- The migration writes the schema name out rather than importing the constant:
  it records what was done to a database on a day, so a later rename must not
  retroactively change what it says.
- **The `@/` alias now works under the TypeORM CLI too.** The `typeorm` script
  runs `node -r ts-node/register -r tsconfig-paths/register` against
  `typeorm/cli.js` instead of the `typeorm-ts-node-commonjs` wrapper, which
  registers ts-node only. Before this, the CLI loaded every entity through the
  glob and died on the first entity importing `@/database/schema`. The old
  "relative imports in `data-source.ts`" exception is gone, along with its
  comments — keep `-r tsconfig-paths/register` and the alias holds everywhere.
- Verified by reverting and re-running the migration: `lease_reminder`
  disappears and comes back, `public` stays at 20 tables throughout.
- `npm run migration:generate` now refuses with an explanation and exit 1. On a
  shared database it would diff jarvis's Prisma-owned `public` schema against
  this app's partial mappings and emit `DROP COLUMN` for everything unmapped.
- All timestamps in this schema are `timestamptz`, unlike jarvis's zone-less
  columns, so writing a `Date` here needs no parser and no agreement about
  which zone the value is "really" in.

- `HEALTH_PROBE_TIMEOUT_MS` (default 2000) and `MAX_PAYLOAD_CHARS` (default
  800) join `app.config.ts`, replacing the constants of the same values that
  used to be hardcoded in `dependency-health.ts` and `log-format.ts`.
  `DatabaseHealthService` and `RabbitmqService` now inject `appConfig.KEY` for
  the timeout; `LoggingInterceptor` and `RabbitmqService` pass
  `maxPayloadChars` into `describePayload` explicitly (it has no default of
  its own any more, so there is exactly one place the number can drift from).
- `.env.example` also gained `EVENT_EXCHANGE` and `EVENT_QUEUE` — already read
  by `rabbitmq.config.ts`, just missing from the template.
- Verified directly: `app.config()` reflects the env vars with correct
  defaults; `withTimeout` actually gives up at the configured ms (50ms
  operation: succeeds at 1000ms, times out at 10ms); a 40-char
  `MAX_PAYLOAD_CHARS` visibly truncates a real logged response that the
  default 800 leaves whole.

### 2026-09-15 — Daily lease expiry scan at 08:00 Tanzania time (uncommitted)

- `LeaseExpiryScanService` runs a scheduled scan — the same query as
  `GET /api/v1/leases/expiring` — and logs every matching lease as one block
  per run (`[LEASE EXPIRY SCAN]` … `[SCANNED] n lease(s)`).
- Schedule from `LEASE_EXPIRY_SCAN_CRON` (default `0 8 * * *`) read in
  `LEASE_EXPIRY_SCAN_TIMEZONE` (default `Africa/Dar_es_Salaam`, i.e. 05:00 UTC).
  An unparseable expression or unknown zone fails at boot.
- New endpoint `POST /api/v1/leases/expiring/scan` runs the scan immediately
  and returns `{ trigger, scannedAt, nextScheduledRunAt, windowDays, leases }`.
- A failed scheduled scan logs one error and waits for the next day; it never
  crashes the process.
- Added `@nestjs/schedule` and `cron`; `ScheduleModule.forRoot()` in
  `AppModule`. `@nestjs/schedule` is held at `^6.1.3` (as in notifier), not
  12.x: 12 ships as ES modules only, and Jest's CommonJS setup here cannot load
  it — every test suite importing `AppModule` fails to run.
- Local `.env`: `LEASE_EXPIRY_SCAN_CRON="0 8 * * *"`,
  `LEASE_EXPIRY_SCAN_TIMEZONE=Africa/Dar_es_Salaam`.

### 2026-09-15 — Response shape back to `windowDays` + `leases` (uncommitted)

- `GET /api/v1/leases/expiring` returns `{ windowDays: [24, 1], leases: [...] }`
  again: the configured `LEASE_EXPIRY_DAYS` (furthest first), then one flat
  list of matching leases, soonest to expire first. Replaces
  `{ periods: [{ days, leases }] }` from `494d54c`.
- Matching is unchanged — a lease is listed when its whole days left equals one
  of `windowDays` exactly. Each lease's `daysLeft` tells which one it matched.
- `README.md`'s "Expiring leases" section still describes the grouped
  `periods` shape; left as is.

### 2026-09-15 — Expiry periods from `LEASE_EXPIRY_DAYS` (`494d54c`)

- `GET /api/v1/leases/expiring` now returns `{ periods: [{ days, leases }] }`,
  one entry per value in `LEASE_EXPIRY_DAYS`, furthest first, empty periods
  included. Replaces the fixed 30-day window and the `windowDays` field.
- A lease is in a period when its whole days left (rounded down) equals it
  exactly, so it appears once at 24 days and again at 1 day. Days left is
  computed in SQL, in the same statement as the filter.
- `LEASE_EXPIRY_DAYS`: blank means `24,1`; order and duplicates are ignored;
  anything but comma-separated whole numbers fails at boot
  (`integerListEnv` in `src/config/env.ts`).
- e2e tests compare each period's lease ids against a plain SQL query.
- Local `.env`: `LEASE_EXPIRY_DAYS=24,1`.

### 2026-09-15 — Read-only database role `automatifier` (no commit — database and `.env` only)

- Role `automatifier` created in `jarvis-db` by the user running a setup
  script: `SELECT` on every table in `public`, `SELECT` on future tables
  created by `postgres` (default privileges), no write grants,
  `default_transaction_read_only = on`.
- Old role `automatifier_ro` dropped, along with its grants and default
  privileges.
- Local `.env`: `DATABASE_USER=automatifier`, new `DATABASE_PASSWORD`, and a
  commented `DATABASE_URL` with the same credentials.

### 2026-09-15 — Safe database flags (`e998b09`)

- `DATABASE_MIGRATIONS_RUN` and `DATABASE_LOGGING` now mean `false` when blank
  or unset, and fail at boot on anything but `true`/`false`
  (`booleanEnv` in `src/config/env.ts`).
- Reverses the earlier default: a blank `DATABASE_MIGRATIONS_RUN` used to run
  migrations, which against jarvis's Prisma-owned database would try to create
  a `migrations` table.

### 2026-09-15 — First expiring-leases endpoint (`f6424e4`)

- `Lease` entity mapped read-only over jarvis's `Lease` table; `leases`
  module, controller, service and response DTOs.
- `pg` type parser for `timestamp without time zone` (OID 1114) in
  `src/database/typeorm.config.ts`, so jarvis's UTC dates are not shifted by
  the machine's offset. Added `@types/pg`.
- "Now" for date filters is taken from the database (`now() AT TIME ZONE
  'UTC'`), never passed in as a JavaScript `Date`.
