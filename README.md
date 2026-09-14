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

## Layout

```
src/
  config/          One registerAs namespace per concern (app, database, rabbitmq)
  common/          Logging interceptor, log formatting, health types
  database/        TypeORM wiring, migrations, the CLI data source
  messaging/       The broker connection. Transport only — it knows no features
  modules/         Features. health/ is the only one so far
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

`DATABASE_MIGRATIONS_RUN` runs pending migrations at boot. Fine for one
process; turn it off and run `migration:run` as a deploy step once this has
replicas, or two instances starting together will race.

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
