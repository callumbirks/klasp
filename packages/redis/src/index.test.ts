import type {
    KlaspInvalidationEvent,
    KlaspObservabilityEvent,
} from "@klasp/core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { redisRealtimeAdapter } from "./index.js";

type RedisErrorListener = (error: unknown) => void;
type RedisSubscriptionListener = (
    message: string,
    channel: string,
) => Promise<void>;

interface FakeRedisClient {
    isOpen: boolean;
    connect: ReturnType<typeof vi.fn<() => Promise<void>>>;
    publish: ReturnType<
        typeof vi.fn<(channel: string, message: string) => Promise<number>>
    >;
    subscribe: ReturnType<
        typeof vi.fn<
            (
                channel: string,
                listener: RedisSubscriptionListener,
            ) => Promise<void>
        >
    >;
    unsubscribe: ReturnType<
        typeof vi.fn<
            (
                channel: string,
                listener: RedisSubscriptionListener,
            ) => Promise<void>
        >
    >;
    quit: ReturnType<typeof vi.fn<() => Promise<void>>>;
    on: ReturnType<
        typeof vi.fn<(event: "error", listener: RedisErrorListener) => void>
    >;
    emitError(error: unknown): void;
}

const redisMock = vi.hoisted(() => {
    type ErrorListener = (error: unknown) => void;
    type SubscriptionListener = (
        message: string,
        channel: string,
    ) => Promise<void>;

    interface Client {
        isOpen: boolean;
        connect: ReturnType<typeof vi.fn<() => Promise<void>>>;
        publish: ReturnType<
            typeof vi.fn<(channel: string, message: string) => Promise<number>>
        >;
        subscribe: ReturnType<
            typeof vi.fn<
                (
                    channel: string,
                    listener: SubscriptionListener,
                ) => Promise<void>
            >
        >;
        unsubscribe: ReturnType<
            typeof vi.fn<
                (
                    channel: string,
                    listener: SubscriptionListener,
                ) => Promise<void>
            >
        >;
        quit: ReturnType<typeof vi.fn<() => Promise<void>>>;
        on: ReturnType<
            typeof vi.fn<(event: "error", listener: ErrorListener) => void>
        >;
        emitError(error: unknown): void;
    }

    const clients: Client[] = [];
    const subscriptionsByChannel = new Map<string, Set<SubscriptionListener>>();

    const createFakeClient = (): Client => {
        const errorListeners = new Set<ErrorListener>();
        const client: Client = {
            isOpen: false,
            connect: vi.fn(async () => {
                client.isOpen = true;
            }),
            publish: vi.fn(async (channel, message) => {
                const listeners = subscriptionsByChannel.get(channel);

                for (const listener of listeners ?? []) {
                    await listener(message, channel);
                }

                return listeners?.size ?? 0;
            }),
            subscribe: vi.fn(async (channel, listener) => {
                const listeners =
                    subscriptionsByChannel.get(channel) ?? new Set();
                listeners.add(listener);
                subscriptionsByChannel.set(channel, listeners);
            }),
            unsubscribe: vi.fn(async (channel, listener) => {
                const listeners = subscriptionsByChannel.get(channel);
                listeners?.delete(listener);

                if (listeners?.size === 0) {
                    subscriptionsByChannel.delete(channel);
                }
            }),
            quit: vi.fn(async () => {
                client.isOpen = false;
            }),
            on: vi.fn((event, listener) => {
                if (event === "error") {
                    errorListeners.add(listener);
                }
            }),
            emitError(error) {
                for (const listener of errorListeners) {
                    listener(error);
                }
            },
        };

        clients.push(client);
        return client;
    };

    return {
        clients,
        createClient: vi.fn(createFakeClient),
        subscriptionsByChannel,
    };
});

vi.mock("redis", () => ({
    createClient: redisMock.createClient,
}));

function getClient(index: number): FakeRedisClient {
    const client = redisMock.clients[index];

    if (!client) {
        throw new Error(`Expected fake Redis client ${index}.`);
    }

    return client as FakeRedisClient;
}

function createDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });

    return { promise, resolve };
}

beforeEach(() => {
    redisMock.clients.length = 0;
    redisMock.createClient.mockClear();
    redisMock.subscriptionsByChannel.clear();
});

describe("redisRealtimeAdapter", () => {
    test("connects the publisher before publishing invalidations", async () => {
        const adapter = redisRealtimeAdapter({ url: "redis://localhost:6379" });
        const publisher = getClient(0);

        await adapter.publishInvalidation("room:a");

        expect(publisher.connect).toHaveBeenCalledTimes(1);
        expect(publisher.publish).toHaveBeenCalledTimes(1);
        expect(publisher.publish.mock.calls[0]?.[0]).toBe(
            "klasp:invalidations",
        );

        const message = publisher.publish.mock.calls[0]?.[1];
        expect(JSON.parse(message ?? "")).toMatchObject({
            type: "invalidate",
            topic: "room:a",
        });
    });

    test("connects the subscriber before subscribing to invalidations", async () => {
        const adapter = redisRealtimeAdapter({ url: "redis://localhost:6379" });
        const subscriber = getClient(1);
        const handler = vi.fn();

        await adapter.subscribeInvalidations(handler);

        expect(subscriber.connect).toHaveBeenCalledTimes(1);
        expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
        expect(subscriber.subscribe.mock.calls[0]?.[0]).toBe(
            "klasp:invalidations",
        );
    });

    test("shares a single publisher connect across concurrent publishes", async () => {
        const adapter = redisRealtimeAdapter({ url: "redis://localhost:6379" });
        const publisher = getClient(0);
        const connect = createDeferred();

        publisher.connect.mockImplementation(async () => {
            await connect.promise;
            publisher.isOpen = true;
        });

        const first = adapter.publishInvalidation("room:a");
        const second = adapter.publishInvalidation("room:b");

        expect(publisher.connect).toHaveBeenCalledTimes(1);

        connect.resolve();
        await Promise.all([first, second]);

        expect(publisher.publish).toHaveBeenCalledTimes(2);
    });

    test("unsubscribe cleanup removes the Redis subscription", async () => {
        const adapter = redisRealtimeAdapter({ url: "redis://localhost:6379" });
        const subscriber = getClient(1);

        const unsubscribe = await adapter.subscribeInvalidations(vi.fn());
        await unsubscribe();
        await unsubscribe();

        expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
        expect(subscriber.unsubscribe.mock.calls[0]?.[0]).toBe(
            "klasp:invalidations",
        );
        expect(subscriber.unsubscribe.mock.calls[0]?.[1]).toBe(
            subscriber.subscribe.mock.calls[0]?.[1],
        );
    });

    test("close unsubscribes active listeners and quits connected clients once", async () => {
        const adapter = redisRealtimeAdapter({ url: "redis://localhost:6379" });
        const publisher = getClient(0);
        const subscriber = getClient(1);

        await adapter.publishInvalidation("room:a");
        await adapter.subscribeInvalidations(vi.fn());
        await adapter.close?.();
        await adapter.close?.();

        expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
        expect(publisher.quit).toHaveBeenCalledTimes(1);
        expect(subscriber.quit).toHaveBeenCalledTimes(1);
    });

    test("rejects publish and subscribe calls after close", async () => {
        const adapter = redisRealtimeAdapter({ url: "redis://localhost:6379" });

        await adapter.close?.();

        await expect(adapter.publishInvalidation("room:a")).rejects.toThrow(
            "Klasp Redis realtime adapter is closed.",
        );
        await expect(adapter.subscribeInvalidations(vi.fn())).rejects.toThrow(
            "Klasp Redis realtime adapter is closed.",
        );
    });

    test("rejects Redis command failures from public methods", async () => {
        const adapter = redisRealtimeAdapter({ url: "redis://localhost:6379" });
        const publisher = getClient(0);
        const subscriber = getClient(1);
        const publishError = new Error("publish failed");
        const subscribeError = new Error("subscribe failed");
        const unsubscribeError = new Error("unsubscribe failed");

        publisher.publish.mockRejectedValueOnce(publishError);
        await expect(adapter.publishInvalidation("room:a")).rejects.toBe(
            publishError,
        );

        subscriber.subscribe.mockRejectedValueOnce(subscribeError);
        await expect(adapter.subscribeInvalidations(vi.fn())).rejects.toBe(
            subscribeError,
        );

        const unsubscribe = await adapter.subscribeInvalidations(vi.fn());
        subscriber.unsubscribe.mockRejectedValueOnce(unsubscribeError);

        await expect(unsubscribe()).rejects.toBe(unsubscribeError);
    });

    test("allows mutations and notifies local subscribers when publishing fails in local_fallback mode", async () => {
        const onError = vi.fn();
        const adapter = redisRealtimeAdapter({
            url: "redis://localhost:6379",
            failureMode: "local_fallback",
            onError,
        });
        const publisher = getClient(0);
        const handler = vi.fn();
        const publishError = new Error("publish failed");

        await adapter.subscribeInvalidations(handler);

        publisher.publish.mockRejectedValueOnce(publishError);

        await expect(adapter.publishInvalidation("room:a")).resolves.toBe(
            undefined,
        );

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]?.[0]).toMatchObject({
            type: "invalidate",
            topic: "room:a",
        });
        expect(onError).toHaveBeenCalledWith(publishError, {
            operation: "publish-fallback",
            channel: "klasp:invalidations",
        });
    });

    test("keeps local subscriptions when subscribing fails in local_fallback mode", async () => {
        const onError = vi.fn();
        const adapter = redisRealtimeAdapter({
            url: "redis://localhost:6379",
            failureMode: "local_fallback",
            onError,
        });
        const publisher = getClient(0);
        const subscriber = getClient(1);
        const handler = vi.fn();
        const subscribeError = new Error("subscribe failed");
        const publishError = new Error("publish failed");

        subscriber.subscribe.mockRejectedValueOnce(subscribeError);
        const unsubscribe = await adapter.subscribeInvalidations(handler);

        publisher.publish.mockRejectedValueOnce(publishError);
        await adapter.publishInvalidation("room:a");

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]?.[0]).toMatchObject({
            type: "invalidate",
            topic: "room:a",
        });
        expect(onError).toHaveBeenCalledWith(subscribeError, {
            operation: "subscribe-fallback",
            channel: "klasp:invalidations",
        });

        await unsubscribe();

        publisher.publish.mockRejectedValueOnce(publishError);
        await adapter.publishInvalidation("room:b");

        expect(handler).toHaveBeenCalledTimes(1);
        expect(subscriber.unsubscribe).not.toHaveBeenCalled();
    });

    test("reports Redis client error events through onError", () => {
        const onError = vi.fn();
        redisRealtimeAdapter({
            url: "redis://localhost:6379",
            onError,
        });
        const publisher = getClient(0);
        const subscriber = getClient(1);
        const publisherError = new Error("publisher failed");
        const subscriberError = new Error("subscriber failed");

        publisher.emitError(publisherError);
        subscriber.emitError(subscriberError);

        expect(onError).toHaveBeenCalledWith(publisherError, {
            operation: "publisher-error",
            channel: "klasp:invalidations",
        });
        expect(onError).toHaveBeenCalledWith(subscriberError, {
            operation: "subscriber-error",
            channel: "klasp:invalidations",
        });
    });

    test("reports malformed messages and handler failures without dropping the subscription", async () => {
        const onError = vi.fn();
        const handlerError = new Error("handler failed");
        const handler = vi.fn(async () => {
            throw handlerError;
        });
        const adapter = redisRealtimeAdapter({
            url: "redis://localhost:6379",
            onError,
        });
        const subscriber = getClient(1);

        await adapter.subscribeInvalidations(handler);
        const listener = subscriber.subscribe.mock.calls[0]?.[1];

        if (!listener) {
            throw new Error("Expected subscription listener.");
        }

        await listener("not json", "klasp:invalidations");
        await listener(
            JSON.stringify({
                type: "invalidate",
                topic: "room:a",
                timestamp: 1,
            } satisfies KlaspInvalidationEvent),
            "klasp:invalidations",
        );

        expect(onError).toHaveBeenCalledWith(expect.any(SyntaxError), {
            operation: "message-parse",
            channel: "klasp:invalidations",
            message: "not json",
        });
        expect(onError).toHaveBeenCalledWith(handlerError, {
            operation: "message-handler",
            channel: "klasp:invalidations",
            message: JSON.stringify({
                type: "invalidate",
                topic: "room:a",
                timestamp: 1,
            }),
        });
        expect(subscriber.unsubscribe).not.toHaveBeenCalled();
    });

    test("uses separate channels for separate namespaces", async () => {
        const first = redisRealtimeAdapter({
            url: "redis://localhost:6379",
            namespace: "app-a",
        });
        const second = redisRealtimeAdapter({
            url: "redis://localhost:6379",
            namespace: "app-b",
        });

        await first.publishInvalidation("room:a");
        await second.publishInvalidation("room:a");

        expect(getClient(0).publish.mock.calls[0]?.[0]).toBe(
            "app-a:invalidations",
        );
        expect(getClient(2).publish.mock.calls[0]?.[0]).toBe(
            "app-b:invalidations",
        );
    });

    test("fans out invalidations across adapter instances using the same namespace", async () => {
        const first = redisRealtimeAdapter({
            url: "redis://localhost:6379",
            namespace: "shared",
        });
        const second = redisRealtimeAdapter({
            url: "redis://localhost:6379",
            namespace: "shared",
        });
        const firstHandler = vi.fn();
        const secondHandler = vi.fn();

        await first.subscribeInvalidations(firstHandler);
        await second.subscribeInvalidations(secondHandler);
        await first.publishInvalidation("room:a");

        expect(firstHandler).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "invalidate",
                topic: "room:a",
            }),
        );
        expect(secondHandler).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "invalidate",
                topic: "room:a",
            }),
        );
    });

    test("does not fan out invalidations across different namespaces", async () => {
        const first = redisRealtimeAdapter({
            url: "redis://localhost:6379",
            namespace: "app-a",
        });
        const second = redisRealtimeAdapter({
            url: "redis://localhost:6379",
            namespace: "app-b",
        });
        const firstHandler = vi.fn();
        const secondHandler = vi.fn();

        await first.subscribeInvalidations(firstHandler);
        await second.subscribeInvalidations(secondHandler);
        await first.publishInvalidation("room:a");

        expect(firstHandler).toHaveBeenCalledWith(
            expect.objectContaining({
                topic: "room:a",
            }),
        );
        expect(secondHandler).not.toHaveBeenCalled();
    });

    test("custom namespace changes the channel from the default", async () => {
        const defaultAdapter = redisRealtimeAdapter({
            url: "redis://localhost:6379",
        });
        const customAdapter = redisRealtimeAdapter({
            url: "redis://localhost:6379",
            namespace: "production",
        });

        await defaultAdapter.subscribeInvalidations(vi.fn());
        await customAdapter.subscribeInvalidations(vi.fn());

        expect(getClient(1).subscribe.mock.calls[0]?.[0]).toBe(
            "klasp:invalidations",
        );
        expect(getClient(3).subscribe.mock.calls[0]?.[0]).toBe(
            "production:invalidations",
        );
    });

    test("emits Redis observability for connect, publish, subscribe, unsubscribe, and close", async () => {
        const events: KlaspObservabilityEvent[] = [];
        const adapter = redisRealtimeAdapter({
            url: "redis://localhost:6379",
            observe(event) {
                events.push(event);
            },
        });

        await adapter.publishInvalidation("room:a");
        const unsubscribe = await adapter.subscribeInvalidations(vi.fn());
        await unsubscribe();
        await adapter.close?.();

        expect(events).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "redis.connect.success",
                    role: "publisher",
                    channel: "klasp:invalidations",
                    durationMs: expect.any(Number),
                }),
                expect.objectContaining({
                    type: "redis.publish.success",
                    channel: "klasp:invalidations",
                    topic: "room:a",
                    durationMs: expect.any(Number),
                }),
                expect.objectContaining({
                    type: "redis.connect.success",
                    role: "subscriber",
                    channel: "klasp:invalidations",
                }),
                expect.objectContaining({
                    type: "redis.subscribe.success",
                    channel: "klasp:invalidations",
                }),
                expect.objectContaining({
                    type: "redis.unsubscribe",
                    channel: "klasp:invalidations",
                }),
                expect.objectContaining({
                    type: "redis.close",
                    channel: "klasp:invalidations",
                }),
            ]),
        );
    });

    test("emits Redis error, fallback, malformed message, and handler failure events", async () => {
        const events: KlaspObservabilityEvent[] = [];
        const adapter = redisRealtimeAdapter({
            url: "redis://localhost:6379",
            failureMode: "local_fallback",
            observe(event) {
                events.push(event);
                throw new Error("observer failed");
            },
        });
        const publisher = getClient(0);
        const subscriber = getClient(1);
        const handlerError = new Error("handler failed");
        const handler = vi.fn(async () => {
            throw handlerError;
        });

        await adapter.subscribeInvalidations(handler);
        const listener = subscriber.subscribe.mock.calls[0]?.[1];

        if (!listener) {
            throw new Error("Expected subscription listener.");
        }

        publisher.publish.mockRejectedValueOnce(new Error("publish failed"));
        await adapter.publishInvalidation("room:a");
        publisher.emitError(new Error("publisher failed"));
        await listener("not json", "klasp:invalidations");
        await listener(
            JSON.stringify({
                type: "invalidate",
                topic: "room:a",
                timestamp: 1,
            } satisfies KlaspInvalidationEvent),
            "klasp:invalidations",
        );

        expect(events).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "redis.publish.error",
                    topic: "room:a",
                    message: "publish failed",
                }),
                expect.objectContaining({
                    type: "redis.fallback",
                    operation: "publish",
                    message: "publish failed",
                }),
                expect.objectContaining({
                    type: "redis.client.error",
                    role: "publisher",
                    message: "publisher failed",
                }),
                expect.objectContaining({
                    type: "redis.message.error",
                    channel: "klasp:invalidations",
                }),
                expect.objectContaining({
                    type: "redis.handler.error",
                    channel: "local",
                    message: "handler failed",
                }),
                expect.objectContaining({
                    type: "redis.handler.error",
                    channel: "klasp:invalidations",
                    message: "handler failed",
                }),
            ]),
        );
    });
});
