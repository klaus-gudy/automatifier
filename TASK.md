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
- [ ] **Decide how "days left" should count.** It is exact time rounded down,
      as jarvis does: on 2026-09-15 at 23:35 EAT a lease ending 2026-09-27 has
      11 days left, where counting calendar dates gives 12. jarvis stores end
      dates at 00:00 UTC (03:00 EAT), so every lease's count drops by one at
      03:00 EAT. Keep this, or count calendar days in EAT?
- [ ] **Scan runs once per process.** Two replicas would each scan at 08:00.
      Harmless while it only logs; needs a lock or a single scheduler instance
      before the scan sends anything.
- [ ] **Next increment** — to be decided.

## Log

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
