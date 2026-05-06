import type { KlaspInvalidationEvent, KlaspRealtimeAdapter } from "@klasp/core";
import { createClient } from "redis";

export interface RedisRealtimeAdapterOptions {
    url: string;
    namespace?: string;
    onError?: (
        error: unknown,
        context: RedisRealtimeAdapterErrorContext,
    ) => void;
}

export type RedisRealtimeAdapterErrorContext =
    | {
          operation: "publisher-error" | "subscriber-error";
          channel: string;
      }
    | {
          operation: "message-parse" | "message-handler";
          channel: string;
          message: string;
      };

type RedisClient = ReturnType<typeof createClient>;
type RedisSubscriptionListener = (
    message: string,
    channel: string,
) => Promise<void>;

const DEFAULT_NAMESPACE = "klasp";

export function redisRealtimeAdapter(
    options: RedisRealtimeAdapterOptions,
): KlaspRealtimeAdapter {
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    const channel = `${namespace}:invalidations`;

    const publisher = createClient({ url: options.url });
    const subscriber = createClient({ url: options.url });
    const subscriptions = new Set<RedisSubscriptionListener>();

    let closed = false;
    let publisherConnectPromise: Promise<void> | undefined;
    let subscriberConnectPromise: Promise<void> | undefined;

    publisher.on("error", (error) => {
        options.onError?.(error, {
            operation: "publisher-error",
            channel,
        });
    });

    subscriber.on("error", (error) => {
        options.onError?.(error, {
            operation: "subscriber-error",
            channel,
        });
    });

    const assertOpen = () => {
        if (closed) {
            throw new Error("Klasp Redis realtime adapter is closed.");
        }
    };

    const ensurePublisherConnected = async () => {
        assertOpen();
        publisherConnectPromise ??= connectClient(publisher).catch((error) => {
            publisherConnectPromise = undefined;
            throw error;
        });
        await publisherConnectPromise;
        assertOpen();
    };

    const ensureSubscriberConnected = async () => {
        assertOpen();
        subscriberConnectPromise ??= connectClient(subscriber).catch(
            (error) => {
                subscriberConnectPromise = undefined;
                throw error;
            },
        );
        await subscriberConnectPromise;
        assertOpen();
    };

    return {
        async publishInvalidation(topic: string) {
            await ensurePublisherConnected();

            const event: KlaspInvalidationEvent = {
                type: "invalidate",
                topic,
                timestamp: Date.now(),
            };

            await publisher.publish(channel, JSON.stringify(event));
        },

        async subscribeInvalidations(handler): Promise<() => Promise<void>> {
            await ensureSubscriberConnected();

            const listener: RedisSubscriptionListener = async (
                message,
                receivedChannel,
            ) => {
                let event: KlaspInvalidationEvent;

                try {
                    event = parseInvalidationEvent(message);
                } catch (error) {
                    options.onError?.(error, {
                        operation: "message-parse",
                        channel: receivedChannel,
                        message,
                    });
                    return;
                }

                try {
                    await handler(event);
                } catch (error) {
                    options.onError?.(error, {
                        operation: "message-handler",
                        channel: receivedChannel,
                        message,
                    });
                }
            };

            assertOpen();
            await subscriber.subscribe(channel, listener);
            subscriptions.add(listener);

            return async () => {
                if (!subscriptions.delete(listener)) {
                    return;
                }

                await subscriber.unsubscribe(channel, listener);
            };
        },

        async close() {
            if (closed) {
                return;
            }

            closed = true;

            const listeners = [...subscriptions];
            subscriptions.clear();

            try {
                for (const listener of listeners) {
                    await subscriber.unsubscribe(channel, listener);
                }
            } finally {
                await Promise.all([
                    quitClient(publisher),
                    quitClient(subscriber),
                ]);
            }
        },
    };
}

async function connectClient(client: RedisClient): Promise<void> {
    if (client.isOpen) {
        return;
    }

    await client.connect();
}

async function quitClient(client: RedisClient): Promise<void> {
    if (!client.isOpen) {
        return;
    }

    await client.quit();
}

function parseInvalidationEvent(message: string): KlaspInvalidationEvent {
    const event = JSON.parse(message) as KlaspInvalidationEvent;

    return event;
}
