import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ConsumeMessage } from 'amqplib';

import appConfig from '@/config/app.config';
import rabbitmqConfig from '@/config/rabbitmq.config';
import { RabbitmqService } from '@/messaging/rabbitmq.service';

/**
 * Covers the acknowledgement policy, which is the part of this service with
 * real consequences: an unacked message stalls the prefetch window, a wrongly
 * requeued one loops forever, and a wrongly rejected one is gone. None of that
 * needs a broker to test — only a channel that records what it was told.
 */
describe('RabbitmqService acknowledgement policy', () => {
  let service: RabbitmqService;
  let ack: jest.Mock;
  let nack: jest.Mock;

  /** A delivery carrying `payload` as a JSON body, or `raw` bytes verbatim. */
  const delivery = (
    body: { payload: unknown } | { raw: string },
    redelivered = false,
  ): ConsumeMessage =>
    ({
      content: Buffer.from(
        'raw' in body ? body.raw : JSON.stringify(body.payload),
      ),
      fields: {
        routingKey: 'thing.happened',
        exchange: 'automatifier.events',
        redelivered,
        deliveryTag: 1,
        credit: 0,
      },
      properties: {},
    }) as unknown as ConsumeMessage;

  /** Drives the private delivery path the consumer callback would reach. */
  const handle = (
    message: ConsumeMessage,
    handler: (payload: unknown, message: ConsumeMessage) => Promise<void>,
  ): Promise<void> =>
    (
      service as unknown as {
        handle: (
          m: ConsumeMessage,
          h: (payload: unknown, message: ConsumeMessage) => Promise<void>,
        ) => Promise<void>;
      }
    ).handle(message, handler);

  beforeEach(async () => {
    ack = jest.fn();
    nack = jest.fn();

    // The failure cases below log an error and a stack trace by design. That is
    // correct in production and pure noise here, where a passing run would
    // otherwise print two stack traces and bury a real failure.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        RabbitmqService,
        { provide: rabbitmqConfig.KEY, useValue: rabbitmqConfig() },
        { provide: appConfig.KEY, useValue: appConfig() },
      ],
    }).compile();

    service = moduleRef.get(RabbitmqService);

    // Stands in for the channel `onModuleInit` would have opened. No broker is
    // involved, so only the two methods the policy actually calls are needed.
    (service as unknown as { channel: unknown }).channel = { ack, nack };
  });

  afterEach(() => jest.restoreAllMocks());

  it('acks a message the handler processed', async () => {
    await handle(delivery({ payload: { id: 1 } }), () => Promise.resolve());

    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).not.toHaveBeenCalled();
  });

  it('hands the parsed payload to the handler', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    await handle(delivery({ payload: { id: 7, name: 'x' } }), handler);

    expect(handler).toHaveBeenCalledWith(
      { id: 7, name: 'x' },
      expect.anything(),
    );
  });

  it('dead-letters an unparseable payload without retrying it', async () => {
    const handler = jest.fn();
    await handle(delivery({ raw: 'not json' }), handler);

    // Never reaches the handler, and never comes back: no amount of retrying
    // turns malformed JSON into a message.
    expect(handler).not.toHaveBeenCalled();
    expect(nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  it('requeues a first-time failure once', async () => {
    await handle(delivery({ payload: { id: 1 } }), () =>
      Promise.reject(new Error('provider timed out')),
    );

    // requeue: true — the third argument.
    expect(nack).toHaveBeenCalledWith(expect.anything(), false, true);
  });

  it('dead-letters a failure that was already redelivered', async () => {
    await handle(delivery({ payload: { id: 1 } }, true), () =>
      Promise.reject(new Error('still failing')),
    );

    // The broker's own `redelivered` flag is what stops the loop, so this
    // holds across a restart of this process rather than resetting with it.
    expect(nack).toHaveBeenCalledWith(expect.anything(), false, false);
    expect(ack).not.toHaveBeenCalled();
  });
});
