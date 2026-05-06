import type {
    KlaspInvalidationEvent,
    KlaspObservabilityEvent,
    KlaspObserve,
    KlaspRealtimeAdapter,
    KlaspRedisRole,
} from "@klasp/core";
import { createClient } from "redis";

export interface RedisRealtimeAdapterOptions {
    url: string;
    namespace?: string;
    /**
     * Controls what happens when Redis cannot publish or receive invalidation
     * messages. Defaults to "drop_messages".
     *
     * `drop_messages` - Drop messages which would be sent through Redis, such as query invalidation. This means
     * realtime will stop working until Redis is available again.
     *
     * `local_fallback` - Continue locally when Redis fails. Failed publishes notify only clients
     * connected to this server instance.
     */
    failureMode?: RedisRealtimeAdapterFailureMode;
    onError?: (
        error: unknown,
        context: RedisRealtimeAdapterErrorContext,
    ) => void;
    observe?: KlaspObserve;
}

export type RedisRealtimeAdapterFailureMode =
    | "local_fallback"
    | "drop_messages";

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
const DEFAULT_FAILURE_MODE: RedisRealtimeAdapterFailureMode = "drop_messages";

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
        safeObserve(options.observe, {
            type: "redis.client.error",
            timestamp: Date.now(),
            role: "publisher",
            channel,
            message: toSafeRedisErrorMessage(error),
        });
        options.onError?.(error, {
            operation: "publisher-error",
            channel,
        });
    });

    subscriber.on("error", (error) => {
        safeObserve(options.observe, {
            type: "redis.client.error",
            timestamp: Date.now(),
            role: "subscriber",
            channel,
            message: toSafeRedisErrorMessage(error),
        });
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
        publisherConnectPromise ??= connectClient(
            publisher,
            "publisher",
            channel,
            options.observe,
        ).catch((error) => {
            publisherConnectPromise = undefined;
            throw error;
        });
        await publisherConnectPromise;
        assertOpen();
    };

    const ensureSubscriberConnected = async () => {
        assertOpen();
        subscriberConnectPromise ??= connectClient(
            subscriber,
            "subscriber",
            channel,
            options.observe,
        ).catch((error) => {
            subscriberConnectPromise = undefined;
            throw error;
        });
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
            const startedAt = Date.now();

            try {
                await ensurePublisherConnected();
                await publisher.publish(channel, JSON.stringify(event));
                safeObserve(options.observe, {
                    type: "redis.publish.success",
                    timestamp: Date.now(),
                    channel,
                    topic,
                    durationMs: Date.now() - startedAt,
                });
            } catch (error) {
                safeObserve(options.observe, {
                    type: "redis.publish.error",
                    timestamp: Date.now(),
                    channel,
                    topic,
                    durationMs: Date.now() - startedAt,
                    message: toSafeRedisErrorMessage(error),
                });
                if (failureMode === "drop_messages") {
                    throw error;
                }

                safeObserve(options.observe, {
                    type: "redis.fallback",
                    timestamp: Date.now(),
                    operation: "publish",
                    channel,
                    message: toSafeRedisErrorMessage(error),
                });
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
                    safeObserve(options.observe, {
                        type: "redis.message.error",
                        timestamp: Date.now(),
                        channel: receivedChannel,
                        message: toSafeRedisErrorMessage(error),
                    });
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
                    safeObserve(options.observe, {
                        type: "redis.handler.error",
                        timestamp: Date.now(),
                        channel: receivedChannel,
                        message: toSafeRedisErrorMessage(error),
                    });
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
            const startedAt = Date.now();

            try {
                await ensureSubscriberConnected();
                assertOpen();
                await subscriber.subscribe(channel, listener);
                subscriptions.add(listener);
                redisSubscribed = true;
                safeObserve(options.observe, {
                    type: "redis.subscribe.success",
                    timestamp: Date.now(),
                    channel,
                    durationMs: Date.now() - startedAt,
                });
            } catch (error) {
                safeObserve(options.observe, {
                    type: "redis.subscribe.error",
                    timestamp: Date.now(),
                    channel,
                    durationMs: Date.now() - startedAt,
                    message: toSafeRedisErrorMessage(error),
                });
                if (failureMode === "drop_messages") {
                    localHandlers.delete(handler);
                    throw error;
                }

                safeObserve(options.observe, {
                    type: "redis.fallback",
                    timestamp: Date.now(),
                    operation: "subscribe",
                    channel,
                    message: toSafeRedisErrorMessage(error),
                });
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
                safeObserve(options.observe, {
                    type: "redis.unsubscribe",
                    timestamp: Date.now(),
                    channel,
                });
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
                safeObserve(options.observe, {
                    type: "redis.close",
                    timestamp: Date.now(),
                    channel,
                });
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
            safeObserve(options.observe, {
                type: "redis.handler.error",
                timestamp: Date.now(),
                channel: "local",
                message: toSafeRedisErrorMessage(error),
            });
            options.onError?.(error, {
                operation: "message-handler",
                channel: "local",
                message,
            });
        }
    }
}

async function connectClient(
    client: RedisClient,
    role: KlaspRedisRole,
    channel: string,
    observe: KlaspObserve | undefined,
): Promise<void> {
    if (client.isOpen) {
        return;
    }

    const startedAt = Date.now();

    try {
        await client.connect();
        safeObserve(observe, {
            type: "redis.connect.success",
            timestamp: Date.now(),
            role,
            channel,
            durationMs: Date.now() - startedAt,
        });
    } catch (error) {
        safeObserve(observe, {
            type: "redis.connect.error",
            timestamp: Date.now(),
            role,
            channel,
            durationMs: Date.now() - startedAt,
            message: toSafeRedisErrorMessage(error),
        });
        throw error;
    }
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

function toSafeRedisErrorMessage(error: unknown): string {
    return error instanceof Error
        ? error.message
        : "Klasp Redis adapter error.";
}

function safeObserve(
    observe: KlaspObserve | undefined,
    event: KlaspObservabilityEvent,
): void {
    try {
        observe?.(event);
    } catch {
        // Observability must not change adapter behavior.
    }
}
