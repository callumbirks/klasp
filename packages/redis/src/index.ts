import type { KlaspInvalidationEvent, KlaspRealtimeAdapter } from "@klasp/core";
import { createClient } from "redis";

export interface RedisRealtimeAdapterOptions {
    url: string;
    namespace?: string;
}

export function redisRealtimeAdapter(
    options: RedisRealtimeAdapterOptions,
): KlaspRealtimeAdapter {
    const namespace = options.namespace ?? "klasp";
    const channel = `${namespace}:invalidations`;

    const publisher = createClient({ url: options.url });
    const subscriber = createClient({ url: options.url });

    return {
        async publishInvalidation(topic: string) {
            const event: KlaspInvalidationEvent = {
                type: "invalidate",
                topic,
                timestamp: Date.now(),
            };

            await publisher.publish(channel, JSON.stringify(event));
        },
        async subscribeInvalidations(handler): Promise<() => Promise<void>> {
            const listener = async (_channel: string, message: string) => {
                const event = JSON.parse(message) as KlaspInvalidationEvent;
                await handler(event);
            };

            await subscriber.subscribe(channel, listener);

            return async () => {
                await subscriber.unsubscribe(channel, listener);
            };
        },
    };
}
