import { registerAs } from '@nestjs/config';

/**
 * Broker settings, as a namespaced config factory.
 *
 * `registerAs` rather than reaching for `ConfigService.get('RABBITMQ_URL')` at
 * each call site: the defaults live in one place, the shape is typed, and a
 * consumer injects `rabbitmqConfig.KEY` instead of remembering a string.
 */
export default registerAs('rabbitmq', () => ({
  /**
   * Lets the whole broker connection be switched off, so the HTTP side can be
   * developed and tested without a RabbitMQ running. Without this the app
   * simply fails to boot on a machine that has no broker.
   */
  enabled: process.env.RABBITMQ_ENABLED !== 'false',

  url: process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672',

  /**
   * The exchange every event is published to. A *topic* exchange, so a future
   * listener can bind `automation.*` or `#` without anything here changing.
   *
   * Nothing publishes to a queue directly — publishers address this exchange,
   * and the bindings decide which queues get a copy.
   */
  exchange: process.env.EVENT_EXCHANGE ?? 'automatifier.events',

  /**
   * **This service's own mailbox.** Named for *who consumes*, deliberately in
   * caps, so it cannot be mistaken for a routing key beside it — the queue and
   * the event are different things, and naming the queue after the event is
   * what makes them look like one.
   *
   * A listener may override it in its own `subscribe` call; this is the
   * default every listener falls back to.
   */
  queue: process.env.EVENT_QUEUE ?? 'AUTOMATIFIER_QUEUE',

  /**
   * Where rejected messages go instead of being destroyed.
   *
   * Derived from the main exchange rather than configured separately: the two
   * are one topology, and letting them be set independently is how you end up
   * with a dead-letter exchange nothing is actually pointed at.
   */
  deadLetterExchange: `${process.env.EVENT_EXCHANGE ?? 'automatifier.events'}.dlx`,

  /**
   * How many unacked messages the broker may have in flight to this process.
   * Low means a slow handler applies backpressure rather than having the whole
   * queue pushed into memory.
   */
  prefetch: Number(process.env.RABBITMQ_PREFETCH ?? 10),
}));
