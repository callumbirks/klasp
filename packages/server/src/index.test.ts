import { KlaspError, type KlaspInvalidationEvent } from "@klasp/core";
import { describe, expect, test } from "vitest";
import {
    createKlasp,
    createKlaspEventsResponse,
    createKlaspRpcResponse,
    type Klasp,
    type KlaspApi,
} from "./index.js";

type InvalidationHandler = (event: KlaspInvalidationEvent) => void;

function createMemoryRealtimeAdapter() {
    const handlers = new Set<InvalidationHandler>();

    return {
        async publishInvalidation(topic: string) {
            const event: KlaspInvalidationEvent = {
                type: "invalidate",
                topic,
                timestamp: Date.now(),
            };

            for (const handler of handlers) {
                handler(event);
            }
        },
        async subscribeInvalidations(handler: InvalidationHandler) {
            handlers.add(handler);

            return async () => {
                handlers.delete(handler);
            };
        },
    };
}

function createTestApi() {
    const realtime = createMemoryRealtimeAdapter();
    const klasp = createKlasp({ realtime });
    const api = klasp.router({
        rooms: {
            messages: klasp.query({
                handler({ input }) {
                    const roomId = String((input as { roomId: string }).roomId);

                    if (roomId === "forbidden") {
                        throw new KlaspError("FORBIDDEN", "No access.");
                    }

                    return { roomId };
                },
                live({ input }) {
                    return {
                        topics: [
                            `room:${(input as { roomId: string }).roomId}`,
                        ],
                    };
                },
            }),
            send: klasp.mutation({
                async handler({ input, klasp: runtime }) {
                    const roomId = String((input as { roomId: string }).roomId);
                    await runtime.invalidate(`room:${roomId}`);
                    return { roomId };
                },
            }),
        },
    });

    return { klasp, api };
}

async function openEvents(klasp: Klasp, clientId: string) {
    const abort = new AbortController();
    const response = await createKlaspEventsResponse({
        klasp,
        request: new Request(
            `http://localhost/klasp/events?clientId=${clientId}`,
            { signal: abort.signal },
        ),
        heartbeatMs: 60_000,
    });
    const reader = response.body?.getReader();

    if (!reader) {
        throw new Error("Expected an SSE response body.");
    }

    await readText(reader);

    return {
        reader,
        abort() {
            abort.abort();
        },
    };
}

async function query(
    klasp: Klasp,
    api: KlaspApi,
    clientId: string | undefined,
    roomId: string,
) {
    const body: Record<string, unknown> = {
        version: 1,
        type: "query",
        path: "rooms.messages",
        input: { roomId },
    };

    if (clientId !== undefined) {
        body.clientId = clientId;
    }

    return createKlaspRpcResponse({
        klasp,
        api,
        request: new Request("http://localhost/klasp/rpc", {
            method: "POST",
            body: JSON.stringify(body),
        }),
    });
}

async function mutation(klasp: Klasp, api: KlaspApi, clientId: string) {
    return createKlaspRpcResponse({
        klasp,
        api,
        request: new Request("http://localhost/klasp/rpc", {
            method: "POST",
            body: JSON.stringify({
                version: 1,
                type: "mutation",
                path: "rooms.send",
                input: { roomId: "mutation-only" },
                clientId,
            }),
        }),
    });
}

async function readText(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    timeoutMs = 100,
): Promise<string | null> {
    const result = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), timeoutMs),
        ),
    ]);

    if (result === "timeout" || result.done) {
        return null;
    }

    return new TextDecoder().decode(result.value);
}

describe("server-side topic authorization", () => {
    test("only emits invalidations to sessions authorized by a successful query", async () => {
        const { klasp, api } = createTestApi();
        const clientA = await openEvents(klasp, "client-a");
        const clientB = await openEvents(klasp, "client-b");

        await query(klasp, api, "client-a", "a");
        await query(klasp, api, "client-b", "b");
        await klasp.runtime.invalidate("room:a");

        expect(await readText(clientA.reader)).toContain("room:a");
        expect(await readText(clientB.reader, 20)).toBeNull();

        clientA.abort();
        clientB.abort();
    });

    test("does not grant topics for failed queries", async () => {
        const { klasp, api } = createTestApi();
        const client = await openEvents(klasp, "client");

        await query(klasp, api, "client", "forbidden");
        await klasp.runtime.invalidate("room:forbidden");

        expect(await readText(client.reader, 20)).toBeNull();

        client.abort();
    });

    test("does not grant topics for mutations", async () => {
        const { klasp, api } = createTestApi();
        const client = await openEvents(klasp, "client");

        await mutation(klasp, api, "client");
        await klasp.runtime.invalidate("room:mutation-only");

        expect(await readText(client.reader, 20)).toBeNull();

        client.abort();
    });

    test("removes authorized topics when an SSE session disconnects", async () => {
        const { klasp, api } = createTestApi();
        const firstConnection = await openEvents(klasp, "client");

        await query(klasp, api, "client", "a");
        firstConnection.abort();

        const secondConnection = await openEvents(klasp, "client");
        await klasp.runtime.invalidate("room:a");

        expect(await readText(secondConnection.reader, 20)).toBeNull();

        secondConnection.abort();
    });

    test("requires a clientId before opening an events stream", async () => {
        const { klasp } = createTestApi();

        const response = await createKlaspEventsResponse({
            klasp,
            request: new Request("http://localhost/klasp/events"),
        });
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body).toMatchObject({
            ok: false,
            error: { code: "BAD_REQUEST" },
        });
    });

    test("queries without a known connected client do not authorize future events", async () => {
        const { klasp, api } = createTestApi();

        await query(klasp, api, "client", "a");
        const client = await openEvents(klasp, "client");
        await klasp.runtime.invalidate("room:a");

        expect(await readText(client.reader, 20)).toBeNull();

        client.abort();
    });
});
