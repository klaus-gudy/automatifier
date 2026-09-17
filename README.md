# Automatifier

A NestJS service wired to Postgres (TypeORM) and RabbitMQ, with request and
message logging and a dependency-aware health probe.

## Running it

```bash
cp .env.example .env
docker compose up -d      # Postgres on 5440, RabbitMQ on 5683 (UI: 15683)
npm install
npm run start:dev
```

- API — `http://localhost:3000/api/v1`
- Health — `http://localhost:3000/health`
- Docs — `http://localhost:3000/docs`

The host ports are shifted off the defaults on purpose, so a Postgres or
RabbitMQ already running locally does not collide with this one.

Set `RABBITMQ_ENABLED=false` to run the HTTP side with no broker at all.

## Expiring leases

`GET /api/v1/leases/expiring` lists active leases (started, not yet ended)
grouped by the periods in `LEASE_EXPIRY_DAYS`, e.g. `LEASE_EXPIRY_DAYS=24,1`.
A lease is in a period when its whole days left is *exactly* that number, so a
lease appears once at 24 days and again at 1 day, never in both at once. Blank
means `24,1`; anything that is not comma-separated whole numbers fails at boot.

## Layout

```
src/
  config/          One registerAs namespace per concern (app, database, lease, rabbitmq)
  common/          Logging interceptor, log formatting, health types
  database/        TypeORM wiring, migrations, the CLI data source
  messaging/       The broker connection. Transport only — it knows no features
  modules/         Features: health/, and leases/ (read-only over jarvis's database)
  configure-app.ts Prefix + validation, shared by main.ts and the e2e test
  swagger.ts       OpenAPI document
```

Import through the `@/` alias (`@/messaging/rabbitmq.service`), not relative
paths. The one exception is `src/database/data-source.ts`, which runs under the
TypeORM CLI outside the alias resolver.

## Adding a feature that consumes events

`MessagingModule` is infrastructure: import it where you need it rather than
making it global, so the dependency stays visible in the module that has it.

```ts
@Injectable()
export class ThingListener implements OnModuleInit {
  constructor(private readonly rabbitmq: RabbitmqService) {}

  async onModuleInit() {
    await this.rabbitmq.subscribe(
      { queue: 'AUTOMATIFIER_THING_QUEUE', routingKeys: ['thing.created'] },
      async (payload) => {
        // Throw to retry once, then dead-letter. Return to ack.
      },
    );
  }
}
```

A queue is _who consumes_ — caps, named for the listener. A routing key is
_what happened_ — lower-case dotted. They are different things, and naming the
queue after the event is what makes them look like one.

Acknowledgement is owned by `RabbitmqService`, not the listener:

| Handler does        | Message goes                               |
| ------------------- | ------------------------------------------ |
| returns             | acked                                      |
| throws, first time  | requeued once                              |
| throws, redelivered | dead-lettered to `<QUEUE>_DEAD`            |
| body is not JSON    | dead-lettered immediately, handler skipped |

The retry limit uses the broker's own `redelivered` flag rather than an
in-memory counter, so it survives a restart of this process.

## Migrations

Schema changes go through migrations only — `synchronize` is off.

```bash
npm run migration:generate -- src/database/migrations/AddSomething
npm run migration:run
npm run migration:revert
```

`DATABASE_MIGRATIONS_RUN=true` runs pending migrations at boot. It is off when
blank or unset, because the database this service reads today is jarvis's, and
its schema belongs to Prisma. Even against a database this service owns, only
turn it on for a single process; once there are replicas, run `migration:run`
as a deploy step, or two instances starting together will race.

`DATABASE_LOGGING=true` prints every SQL statement. Off when blank or unset.

Both accept only `true` or `false` (any case) — anything else fails at boot
with the variable's name, rather than quietly falling back to a default.

## Logging

`LoggingInterceptor` logs every HTTP request, response and error;
`RabbitmqService` logs every delivery in the same layout. Both redact
credential-shaped keys and truncate long payloads (`common/logging/log-format.ts`).

Request bodies are off by default — set `LOG_REQUEST_BODY=true` to include them.

## Tests

```bash
npm test          # unit
npm run test:e2e  # needs `docker compose up -d` — it connects for real
```

## Lease reminders

The daily scan (`LEASE_EXPIRY_SCAN_CRON`, `08:00` `LEASE_EXPIRY_SCAN_TIMEZONE`
by default) records a reminder per expiring lease and publishes it as an SMS
event on jarvis's broker, for notifier's `NOTIFIER_SMS_QUEUE` to pick up.

Check what's sitting in the queue:

```bash
docker exec jarvis-mq rabbitmqctl list_queues name messages | grep NOTIFIER_SMS
```

Purge it — needed after a manual or test scan, since anything left there goes
out as a real text the moment a consumer exists:

```bash
docker exec jarvis-mq rabbitmqctl purge_queue NOTIFIER_SMS_QUEUE
```

Clear recorded reminders — needed to re-run the same scan and get new
publishes, since a lease already recorded for a period is treated as already
reminded and is not published again:

```bash
docker exec jarvis-db psql -U automatifier -d jarvis -c "DELETE FROM automatifier.lease_reminder"
```
