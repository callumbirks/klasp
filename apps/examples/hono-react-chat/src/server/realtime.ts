import type { KlaspInvalidationEvent, KlaspRealtimeAdapter } from "@klasp/core";

type InvalidationHandler = (
    event: KlaspInvalidationEvent,
) => Promise<void> | void;

export function createMemoryRealtimeAdapter(): KlaspRealtimeAdapter {
    const handlers = new Set<InvalidationHandler>();

    return {
        async publishInvalidation(topic: string) {
            const event: KlaspInvalidationEvent = {
                type: "invalidate",
                topic,
                timestamp: Date.now(),
            };

            await Promise.all(
                Array.from(handlers, async (handler) => handler(event)),
            );
        },
        async subscribeInvalidations(handler: InvalidationHandler) {
            handlers.add(handler);

            return async () => {
                handlers.delete(handler);
            };
        },
    };
}
