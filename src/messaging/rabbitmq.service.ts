import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  connect,
  type AmqpConnectionManager,
  type ChannelWrapper,
} from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';

import {
  HEALTH_PROBE_TIMEOUT_MS,
  OptionalDependencyHealth,
  withTimeout,
} from '@/common/dependency-health';
import { describePayload, SEPARATOR } from '@/common/logging/log-format';
import rabbitmqConfig from '@/config/rabbitmq.config';

/** What a feature module needs to declare to receive its events. */
export type Subscription = {
  /** The queue this listener owns. One queue per listener, never shared. */
  queue: string;
  /** Routing keys to bind it to on the exchange. */
  routingKeys: string[];
};

/** What a handler tells this service to do with the message it was given. */
export type HandlerOutcome =
  /** Done with it. The broker drops it. */
  | 'ack'
  /** Will never succeed — bad payload, unknown type. Straight to the DLQ. */
  | 'reject'
  /**
   * Failed for a reason that might not repeat. Requeued *once* — a message
   * already marked `redelivered` is dead-lettered instead, so a poison message
   * cannot loop forever and block everything behind it.
   */
  | 'retry';

/**
 * The connection to RabbitMQ. **Transport only** — it knows nothing about any
 * feature in this app.
 *
 * That separation is the point of this module: features declare their own
 * topology through `subscribe`, and this stays a socket and a channel. Adding
 * a second listener never means editing this file.
 *
 * Written against `amqplib` through `amqp-connection-manager`, not
 * `@nestjs/microservices`'s RMQ transport, which owns the wire format: it wraps
 * every body in its own `{ pattern, data }` envelope and binds queues by
 * pattern name. A publisher sending plain JSON to a topic exchange would not be
 * understood, and its messages would be dropped as unroutable.
 *
 * `amqp-connection-manager` over bare `amqplib` for one reason — it reconnects.
 * Every piece of topology below is declared inside a `setup` function, which
 * the library replays on each reconnect, so a broker restart costs this process
 * a gap in consumption rather than a manual restart of its own.
 */
@Injectable()
export class RabbitmqService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitmqService.name);

  private connection?: AmqpConnectionManager;
  private channel?: ChannelWrapper;

  /** Consecutive failed connection attempts, for throttling the log above. */
  private failedAttempts = 0;

  constructor(
    @Inject(rabbitmqConfig.KEY)
    private readonly config: ConfigType<typeof rabbitmqConfig>,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logger.warn(
        'RABBITMQ_ENABLED=false — no broker connection. Publishes will throw ' +
          'and no listener will receive anything.',
      );
      return;
    }

    /*
     * Deliberately not awaited. `connect` starts the connection and retries in
     * the background, so the app boots and serves HTTP while the broker is
     * still coming up — the alternative is a crash loop whenever this service
     * happens to start before RabbitMQ does.
     */
    this.connection = connect([this.config.url]);

    this.connection.on('connect', () => {
      this.failedAttempts = 0;
      this.logger.log(
        `connected — exchange "${this.config.exchange}" (topic), ` +
          `dead letters to "${this.config.deadLetterExchange}"`,
      );
    });

    /*
     * An *established* connection dropping. A warning, not an error: the
     * library is already retrying, and this line is followed by a `connect` as
     * soon as the broker is back.
     */
    this.connection.on('disconnect', ({ err }) =>
      this.logger.warn(
        `disconnected, retrying: ${err?.message ?? 'unknown reason'}`,
      ),
    );

    /*
     * A connection *attempt* failing — a separate event, and the one that fires
     * when the broker is simply not up yet at boot. Without it that case logs
     * nothing at all: no `disconnect` is emitted, because there was never a
     * connection to lose, and the service sits there silently retrying while
     * looking healthy in the terminal.
     *
     * Throttled, because it retries every few seconds indefinitely and an
     * overnight broker outage would otherwise be a log file full of one line.
     */
    this.connection.on('connectFailed', ({ err }) => {
      this.failedAttempts += 1;

      if (this.failedAttempts === 1) {
        this.logger.error(
          `cannot reach ${this.safeUrl()}: ${this.describe(err)}`,
        );
      } else if (this.failedAttempts % 10 === 0) {
        this.logger.error(
          `still cannot reach the broker after ${this.failedAttempts} ` +
            `attempts: ${this.describe(err)}`,
        );
      }
    });

    /*
     * The broker refusing new publishes because it is out of memory or disk.
     * Publishes do not fail — they block — so without this line the symptom is
     * a process that appears to hang for no reason.
     */
    this.connection.on('blocked', ({ reason }) =>
      this.logger.error(`broker has blocked publishing: ${reason}`),
    );
    this.connection.on('unblocked', () =>
      this.logger.log('broker has unblocked publishing'),
    );

    this.channel = this.connection.createChannel({
      // This service serialises its own payloads, so the wrapper must not also
      // JSON-encode them — that would double-encode every publish.
      json: false,
      setup: async (channel: ConfirmChannel) => {
        /*
         * Asserted, not assumed. Idempotent while the arguments match, so this
         * app can start before any publisher has ever run — otherwise a topic
         * exchange with no bound queue silently drops everything it receives.
         */
        await channel.assertExchange(this.config.exchange, 'topic', {
          durable: true,
        });

        /*
         * The holding area, declared before any queue points at it. A
         * dead-letter exchange with no queue bound behaves exactly like having
         * none at all — the broker publishes the rejected message, nothing is
         * listening, and it is dropped just as silently.
         *
         * `direct`, not `fanout`: every listener's rejects come through this
         * one exchange, and a fanout would copy each one into *every* dead
         * queue. Each binding uses the originating queue's own name as the key.
         */
        await channel.assertExchange(this.config.deadLetterExchange, 'direct', {
          durable: true,
        });

        await channel.prefetch(this.config.prefetch);
      },
    });
  }

  /**
   * Is the broker actually reachable right now.
   *
   * `checkExchange` is the probe because it is a read-only round trip against
   * something already known to exist (asserted at startup), so a healthy broker
   * answers it with no side effect.
   */
  async checkHealth(): Promise<OptionalDependencyHealth> {
    if (!this.config.enabled) return { status: 'disabled' };

    if (!this.connection?.isConnected() || !this.channel) {
      return { status: 'down', error: 'not connected' };
    }

    const startedAt = Date.now();
    try {
      await withTimeout(
        this.channel.checkExchange(this.config.exchange),
        HEALTH_PROBE_TIMEOUT_MS,
      );
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (cause) {
      return {
        status: 'down',
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  /**
   * Publishes one event onto the exchange, for anything bound to hear it.
   *
   * The channel is in confirm mode, so the returned promise resolves when the
   * *broker* has taken responsibility for the message — not merely when it was
   * written to a socket. While disconnected, the message is buffered in memory
   * and flushed on reconnect, which is why this is safe to call during a blip
   * but not a durable outbox: a process that dies with messages still buffered
   * loses them. Anything that must survive that belongs in the database first.
   */
  async publish(routingKey: string, payload: unknown): Promise<void> {
    const channel = this.requireChannel();

    await channel.publish(
      this.config.exchange,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      {
        contentType: 'application/json',
        // Survives a broker restart, in a durable queue. Without it the message
        // is held in memory only and a restart discards it.
        persistent: true,
        timestamp: Date.now(),
      },
    );

    this.logger.log(`[PUBLISHED] ${routingKey} ${describePayload(payload)}`);
  }

  /**
   * Declares a listener's queue, binds it, and starts delivering.
   *
   * Registered through `addSetup` rather than run once here, so the library
   * replays the whole declaration — queue, bindings, consumer — after every
   * reconnect. The queue is durable and the bindings are re-asserted on each
   * boot, so a message published while this process was down is waiting when it
   * returns rather than having been dropped.
   *
   * The handler returns what should happen to the message; this owns the
   * ack/nack so no listener can leave one unacked by forgetting to.
   */
  async subscribe(
    subscription: Subscription,
    handler: (payload: unknown, message: ConsumeMessage) => Promise<void>,
  ): Promise<void> {
    const channel = this.requireChannel();
    const { queue, routingKeys } = subscription;
    const deadLetterQueue = `${queue}_DEAD`;

    await channel.addSetup(async (ch: ConfirmChannel) => {
      await ch.assertQueue(deadLetterQueue, { durable: true });
      await ch.bindQueue(
        deadLetterQueue,
        this.config.deadLetterExchange,
        queue,
      );

      await this.assertWorkQueue(ch, queue);

      for (const routingKey of routingKeys) {
        await ch.bindQueue(queue, this.config.exchange, routingKey);
      }

      await ch.consume(queue, (message) => {
        // A null delivery means the consumer was cancelled broker-side — there
        // is nothing to ack and nothing to handle.
        if (message) void this.handle(message, handler);
      });
    });

    this.logger.log(
      `listening on "${queue}" for [${routingKeys.join(', ')}] — ` +
        `rejects held in "${deadLetterQueue}"`,
    );
  }

  /**
   * Runs one delivery through a handler and decides its fate.
   *
   * Every path here ends in an ack or a nack. A message that is neither stays
   * unacked forever, counts against the prefetch window, and is only released
   * when the connection drops — which looks like a service that mysteriously
   * stops consuming after exactly `prefetch` messages.
   */
  private async handle(
    message: ConsumeMessage,
    handler: (payload: unknown, message: ConsumeMessage) => Promise<void>,
  ): Promise<void> {
    const channel = this.requireChannel();
    const { routingKey } = message.fields;
    const startedAt = Date.now();

    let payload: unknown;
    try {
      payload = JSON.parse(message.content.toString('utf8'));
    } catch (cause) {
      // A retry cannot make malformed JSON parse. Straight to the DLQ.
      this.logger.error(
        `[REJECTED] ${routingKey} — unparseable payload: ${this.describe(cause)}`,
      );
      channel.nack(message, false, false);
      return;
    }

    this.logger.log(`\n${SEPARATOR}`);
    this.logger.log(
      `[INCOMING MESSAGE] ${routingKey} -> ${message.fields.exchange || '(default)'}`,
    );
    this.logger.log(`  payload: ${describePayload(payload)}`);

    try {
      await handler(payload, message);
      channel.ack(message);
      this.logger.log(`[HANDLED] ${routingKey} +${Date.now() - startedAt}ms`);
      this.logger.log(`${SEPARATOR}\n`);
    } catch (cause) {
      /*
       * One retry, then the DLQ. `redelivered` is the broker's own flag, so
       * this survives a restart of this process — it is not a counter held in
       * memory that resets and lets a poison message loop forever.
       */
      const requeue = !message.fields.redelivered;

      this.logger.error(
        `[FAILED] ${routingKey} +${Date.now() - startedAt}ms — ` +
          `${this.describe(cause)}; ` +
          (requeue ? 'requeueing once' : 'dead-lettering'),
      );
      if (cause instanceof Error && cause.stack) this.logger.error(cause.stack);
      this.logger.error(`${SEPARATOR}\n`);

      channel.nack(message, false, requeue);
    }
  }

  /**
   * Declares the work queue, with its rejects routed to the holding area.
   *
   * **A queue's settings are fixed at creation and cannot be edited.** If one
   * already exists with different settings — which is exactly what happens the
   * first time this runs against a broker that knew the queue *before* it had a
   * dead-letter exchange — the broker refuses with `PRECONDITION_FAILED` and
   * closes the channel. Nothing is silently reconfigured and nothing is lost;
   * it simply will not start until someone decides what to do with the old
   * queue. The catch below turns that into a sentence a person can act on
   * rather than a bare AMQP code.
   */
  private async assertWorkQueue(
    channel: ConfirmChannel,
    queue: string,
  ): Promise<void> {
    try {
      await channel.assertQueue(queue, {
        durable: true,
        deadLetterExchange: this.config.deadLetterExchange,
        // Routed by the queue's own name so its rejects are told apart from
        // every other listener's on the shared dead-letter exchange.
        deadLetterRoutingKey: queue,
      });
    } catch (cause) {
      const message = this.describe(cause);

      if (message.includes('PRECONDITION_FAILED')) {
        this.logger.error(
          `queue "${queue}" already exists with different settings — almost ` +
            `certainly from before it had a dead-letter exchange. A queue ` +
            `cannot be reconfigured in place: drain it, delete it, and let ` +
            `this service recreate it.\n` +
            `  docker exec <broker> rabbitmqctl delete_queue ${queue}`,
        );
      }

      throw cause;
    }
  }

  private requireChannel(): ChannelWrapper {
    if (!this.channel) {
      throw new Error(
        this.config.enabled
          ? 'RabbitMQ channel is not open'
          : 'RabbitMQ is disabled (RABBITMQ_ENABLED=false)',
      );
    }
    return this.channel;
  }

  /**
   * A failure as a non-empty string.
   *
   * The fallbacks are not defensive padding: amqplib rejects a refused
   * connection with an error whose `message` is the empty string, so the
   * obvious `error.message` produces a log line that names no cause at all.
   */
  private describe(error: unknown): string {
    if (!(error instanceof Error)) return String(error);

    if (error.message) return error.message;

    const code = (error as NodeJS.ErrnoException).code;
    return code ?? error.name ?? 'unknown error';
  }

  /**
   * The broker URL with its credentials stripped, for logging.
   *
   * `amqp://guest:guest@host` is the documented default and a real password in
   * every other environment — printing it verbatim writes that password into
   * the log on every failed connection attempt, which is exactly what the
   * redaction in `log-format.ts` exists to prevent elsewhere.
   */
  private safeUrl(): string {
    try {
      const url = new URL(this.config.url);
      url.username = '';
      url.password = '';
      return url.toString();
    } catch {
      // Not parseable as a URL, so there is nothing to strip — and nothing
      // safe to assume either. Say where it came from instead of printing it.
      return '(the configured RABBITMQ_URL)';
    }
  }

  /**
   * Closes the channel then the connection, in that order.
   *
   * Without this, SIGTERM drops the socket mid-message and the broker waits out
   * a timeout before redelivering. Closing properly stops the consumer, lets
   * in-flight handlers finish, and hands anything unacked back immediately.
   *
   * Reached only because `main.ts` calls `app.enableShutdownHooks()`.
   */
  async onApplicationShutdown(): Promise<void> {
    try {
      await this.channel?.close();
      await this.connection?.close();
      this.logger.log('connection closed cleanly');
    } catch {
      // Already closing, or the socket is gone. Nothing left to close.
    } finally {
      this.channel = undefined;
      this.connection = undefined;
    }
  }
}
