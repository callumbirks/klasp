import type { KlaspInvalidationEvent, KlaspRealtimeAdapter } from "@klasp/core";
import { createClient } from "redis";

export interface RedisRealtimeAdapterOptions {
    url: string;
    namespace?: string;
    failureMode?: RedisRealtimeAdapterFailureMode;
    onError?: (
        error: unknown,
        context: RedisRealtimeAdapterErrorContext,
    ) => void;
}

export type RedisRealtimeAdapterFailureMode =
    | "allow_mutations"
    | "local_fallback";

export type RedisRealtimeAdapterErrorContext =
    | {
          operation: "publisher-error" | "subscriber-error";
          channel: string;
      }
    | {
          operation: "publish-fallback" | "subscribe-fallback";
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
type InvalidationHandler = Parameters<
    KlaspRealtimeAdapter["subscribeInvalidations"]
>[0];

const DEFAULT_NAMESPACE = "klasp";
const DEFAULT_FAILURE_MODE: RedisRealtimeAdapterFailureMode = "local_fallback";

export function redisRealtimeAdapter(
    options: RedisRealtimeAdapterOptions,
): KlaspRealtimeAdapter {
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    const channel = `${namespace}:invalidations`;
    const failureMode = options.failureMode ?? DEFAULT_FAILURE_MODE;

    const publisher = createClient({ url: options.url });
    const subscriber = createClient({ url: options.url });
    const subscriptions = new Set<RedisSubscriptionListener>();
    const localHandlers = new Set<InvalidationHandler>();

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
            const event: KlaspInvalidationEvent = {
                type: "invalidate",
                topic,
                timestamp: Date.now(),
            };

            try {
                await ensurePublisherConnected();
                await publisher.publish(channel, JSON.stringify(event));
            } catch (error) {
                if (failureMode === "local_fallback") {
                    throw error;
                }

                options.onError?.(error, {
                    operation: "publish-fallback",
                    channel,
                });
                await publishLocalInvalidation(event, localHandlers, options);
            }
        },

        async subscribeInvalidations(handler): Promise<() => Promise<void>> {
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
            localHandlers.add(handler);

            let redisSubscribed = false;

            try {
                await ensureSubscriberConnected();
                assertOpen();
                await subscriber.subscribe(channel, listener);
                subscriptions.add(listener);
                redisSubscribed = true;
            } catch (error) {
                if (failureMode === "local_fallback") {
                    localHandlers.delete(handler);
                    throw error;
                }

                options.onError?.(error, {
                    operation: "subscribe-fallback",
                    channel,
                });
            }

            return async () => {
                localHandlers.delete(handler);

                if (!redisSubscribed || !subscriptions.delete(listener)) {
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

async function publishLocalInvalidation(
    event: KlaspInvalidationEvent,
    handlers: Set<InvalidationHandler>,
    options: RedisRealtimeAdapterOptions,
): Promise<void> {
    const message = JSON.stringify(event);

    for (const handler of handlers) {
        try {
            await handler(event);
        } catch (error) {
            options.onError?.(error, {
                operation: "message-handler",
                channel: "local",
                message,
            });
        }
    }
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
