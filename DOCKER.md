# Production container

Build from this project directory:

```sh
docker build -t automatifier:local .
docker run --rm --name automatifier -p 3000:3000 --env-file /path/to/runtime.env automatifier:local
```

The image builds with Node 24.18.0 and runs compiled JavaScript as the non-root
`node` user. Only production dependencies, compiled code (including migrations),
and package metadata enter the runtime image. Local `.env*` files are excluded;
supply secrets and connection settings at runtime. `PORT` defaults to 3000.
Choose a different host port, such as `-p 3001:3000`, when running both services.

Set `DATABASE_URL` (or the discrete `DATABASE_*` settings) and `RABBITMQ_URL`
to addresses reachable from the container. On a shared Docker network, use
service names and container ports; on Docker Desktop, `host.docker.internal`
reaches services published on the host. `localhost` refers to this container.

The default command is `node dist/main.js`. Keep it as the deployment start
command; development commands need tooling deliberately omitted from this image.

## Database and queues

This service reads Jarvis's `public` schema and owns the separate `automatifier`
schema. Provision that schema and its permissions first, and apply Jarvis's
migrations before using lease features. Startup migrations remain opt-in via
`DATABASE_MIGRATIONS_RUN=true`; the Dockerfile does not enable them.
For a separate migration step, run the compiled CLI:

```sh
docker run --rm --env-file /path/to/runtime.env automatifier:local \
  node node_modules/typeorm/cli.js -d dist/database/data-source.js migration:run
```

Never generate migrations against the shared database. Use a single scheduler
replica unless a distributed scheduling lock is added. `RABBITMQ_ENABLED=false`
disables messaging when checking the HTTP/database side in isolation.
