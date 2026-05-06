import { describe, expect, test, vi } from "vitest";
import { type KlaspObservabilityEvent, klaspObserveConsole } from "./index.js";

function createConsole() {
    return {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    };
}

describe("klaspObserveConsole", () => {
    test("logs normal events to debug by default without the discriminant in metadata", () => {
        const logger = createConsole();
        const observe = klaspObserveConsole({ console: logger });
        const event = {
            type: "client.rpc.success",
            timestamp: 1,
            path: "rooms.messages",
            procedureType: "query",
            clientId: "client",
            durationMs: 2,
            liveTopicCount: 1,
        } satisfies KlaspObservabilityEvent;

        observe(event);

        expect(logger.debug).toHaveBeenCalledWith(
            "[klasp] client.rpc.success",
            {
                timestamp: 1,
                path: "rooms.messages",
                procedureType: "query",
                clientId: "client",
                durationMs: 2,
                liveTopicCount: 1,
            },
        );
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.info).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    test("can promote normal events to info", () => {
        const logger = createConsole();
        const observe = klaspObserveConsole({
            console: logger,
            level: "info",
        });

        observe({
            type: "server.sse.open",
            timestamp: 1,
            clientId: "client",
        });

        expect(logger.info).toHaveBeenCalledWith("[klasp] server.sse.open", {
            timestamp: 1,
            clientId: "client",
        });
        expect(logger.debug).not.toHaveBeenCalled();
    });

    test("routes errors and Redis fallbacks to louder console methods", () => {
        const logger = createConsole();
        const observe = klaspObserveConsole({ console: logger });

        observe({
            type: "server.rpc.error",
            timestamp: 1,
            errorCode: "BAD_REQUEST",
            message: "Bad request.",
        });
        observe({
            type: "redis.fallback",
            timestamp: 2,
            operation: "publish",
            channel: "klasp:invalidations",
            message: "publish failed",
        });

        expect(logger.error).toHaveBeenCalledWith("[klasp] server.rpc.error", {
            timestamp: 1,
            errorCode: "BAD_REQUEST",
            message: "Bad request.",
        });
        expect(logger.warn).toHaveBeenCalledWith("[klasp] redis.fallback", {
            timestamp: 2,
            operation: "publish",
            channel: "klasp:invalidations",
            message: "publish failed",
        });
    });
});
