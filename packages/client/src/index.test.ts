import { createKlaspContract, KlaspError } from "@klasp/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createKlaspClient } from "./index.js";

class FakeEventSource {
    static instances: FakeEventSource[] = [];
    static urls: string[] = [];

    private readonly listeners = new Map<
        string,
        Set<(event: MessageEvent) => void>
    >();

    constructor(public readonly url: string) {
        FakeEventSource.urls.push(url);
        FakeEventSource.instances.push(this);
    }

    addEventListener(event: string, listener: (event: MessageEvent) => void) {
        const listeners = this.listeners.get(event) ?? new Set();
        listeners.add(listener);
        this.listeners.set(event, listeners);
    }

    removeEventListener(
        event: string,
        listener: (event: MessageEvent) => void,
    ) {
        this.listeners.get(event)?.delete(listener);
    }

    close() {}

    emit(event: string, data: unknown) {
        for (const listener of this.listeners.get(event) ?? []) {
            listener({ data: JSON.stringify(data) } as MessageEvent);
        }
    }
}

const contract = createKlaspContract();
const api = contract.router({
    rooms: {
        messages: contract.query<{ roomId: string }, string[]>(),
        sendMessage: contract.mutation<
            { roomId: string; text: string },
            string
        >(),
    },
});

describe("createKlaspClient", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        FakeEventSource.instances = [];
        FakeEventSource.urls = [];
    });

    test("includes the client id in RPC requests and event streams", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const requests: unknown[] = [];
        const fetch = createFetch(
            [
                {
                    ok: true,
                    data: null,
                    live: undefined,
                    error: undefined,
                },
            ],
            requests,
        );
        const client = createKlaspClient({
            endpoint: "http://localhost/klasp",
            fetch,
            clientId: "test-client",
        });

        await client.query("rooms.messages", { roomId: "a" });

        expect(requests).toEqual([
            expect.objectContaining({
                type: "query",
                path: "rooms.messages",
                clientId: "test-client",
            }),
        ]);
        expect(FakeEventSource.urls).toEqual([
            "http://localhost/klasp/events?clientId=test-client",
        ]);
    });

    test("uses a stable unique id per client instance", () => {
        const first = createKlaspClient({
            endpoint: "http://localhost/klasp",
            fetch: vi.fn() as unknown as typeof fetch,
        });
        const second = createKlaspClient({
            endpoint: "http://localhost/klasp",
            fetch: vi.fn() as unknown as typeof fetch,
        });

        expect(first.clientId).toEqual(expect.any(String));
        expect(second.clientId).toEqual(expect.any(String));
        expect(first.clientId).not.toBe(second.clientId);
    });

    test("resolves contract procedures and returns unwrapped query and mutation data", async () => {
        const requests: unknown[] = [];
        const fetch = createFetch(
            [
                {
                    ok: true,
                    data: ["hello"],
                    live: { topics: ["room:a"] },
                    error: undefined,
                },
                {
                    ok: true,
                    data: "sent",
                    live: undefined,
                    error: undefined,
                },
            ],
            requests,
        );
        const client = createKlaspClient({
            api,
            endpoint: "http://localhost/klasp",
            fetch,
            clientId: "test-client",
        });

        await expect(
            client.query(api.rooms.messages, { roomId: "a" }),
        ).resolves.toEqual(["hello"]);
        await expect(
            client.mutation(api.rooms.sendMessage, {
                roomId: "a",
                text: "hi",
            }),
        ).resolves.toBe("sent");

        expect(requests).toEqual([
            expect.objectContaining({
                type: "query",
                path: "rooms.messages",
            }),
            expect.objectContaining({
                type: "mutation",
                path: "rooms.sendMessage",
            }),
        ]);
    });

    test("throws KlaspError for failed RPC responses", async () => {
        const fetch = createFetch([
            {
                ok: false,
                data: undefined,
                live: undefined,
                error: {
                    code: "FORBIDDEN",
                    message: "Nope.",
                    details: { reason: "test" },
                },
            },
        ]);
        const client = createKlaspClient({
            endpoint: "http://localhost/klasp",
            fetch,
        });

        await expect(
            client.query("rooms.messages", { roomId: "a" }),
        ).rejects.toMatchObject({
            code: "FORBIDDEN",
            message: "Nope.",
            details: { reason: "test" },
        } satisfies Partial<KlaspError>);
    });

    test("creates deterministic resource keys for equivalent object input order", () => {
        const client = createKlaspClient({
            endpoint: "http://localhost/klasp",
            fetch: vi.fn() as unknown as typeof fetch,
        });

        expect(
            client.getResourceKey("rooms.messages", { roomId: "a", page: 1 }),
        ).toBe(
            client.getResourceKey("rooms.messages", { page: 1, roomId: "a" }),
        );
    });

    test("updates query resource state across success and error refetches", async () => {
        const fetch = createFetch([
            {
                ok: true,
                data: ["first"],
                live: { topics: ["room:a"] },
                error: undefined,
            },
            {
                ok: false,
                data: undefined,
                live: undefined,
                error: {
                    code: "INTERNAL_SERVER_ERROR",
                    message: "Failed.",
                },
            },
        ]);
        const client = createKlaspClient({
            endpoint: "http://localhost/klasp",
            fetch,
        });
        const resource = client.createQueryResource<
            { roomId: string },
            string[]
        >("rooms.messages", { roomId: "a" });
        const states: string[] = [];
        resource.subscribe((state) => {
            states.push(state.status);
        });

        await expect(resource.refetch()).resolves.toEqual(["first"]);
        await expect(resource.refetch()).rejects.toThrow("Failed.");

        expect(resource.getSnapshot()).toMatchObject({
            data: ["first"],
            error: expect.any(KlaspError),
            status: "error",
            isError: true,
        });
        expect(states).toEqual([
            "loading",
            "loading",
            "success",
            "loading",
            "error",
        ]);
    });

    test("refreshes only resources mapped to an invalidated live topic", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const requests: unknown[] = [];
        const fetch = createFetch(
            [
                {
                    ok: true,
                    data: ["a1"],
                    live: { topics: ["room:a"] },
                    error: undefined,
                },
                {
                    ok: true,
                    data: ["b1"],
                    live: { topics: ["room:b"] },
                    error: undefined,
                },
                {
                    ok: true,
                    data: ["a2"],
                    live: { topics: ["room:a"] },
                    error: undefined,
                },
            ],
            requests,
        );
        const client = createKlaspClient({
            endpoint: "http://localhost/klasp",
            fetch,
        });
        const roomA = client.createQueryResource<{ roomId: string }, string[]>(
            "rooms.messages",
            { roomId: "a" },
        );
        const roomB = client.createQueryResource<{ roomId: string }, string[]>(
            "rooms.messages",
            { roomId: "b" },
        );

        await roomA.refetch();
        await roomB.refetch();
        FakeEventSource.instances[0]?.emit("klasp.invalidate", {
            topic: "room:a",
        });
        await waitFor(() => roomA.getSnapshot().data?.[0] === "a2");

        expect(roomA.getSnapshot().data).toEqual(["a2"]);
        expect(roomB.getSnapshot().data).toEqual(["b1"]);
        expect(
            requests.map((request) => (request as { input: unknown }).input),
        ).toEqual([{ roomId: "a" }, { roomId: "b" }, { roomId: "a" }]);
    });

    test("disposal unregisters live topic mappings and listeners", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const requests: unknown[] = [];
        const fetch = createFetch(
            [
                {
                    ok: true,
                    data: ["a1"],
                    live: { topics: ["room:a"] },
                    error: undefined,
                },
            ],
            requests,
        );
        const client = createKlaspClient({
            endpoint: "http://localhost/klasp",
            fetch,
        });
        const resource = client.createQueryResource<
            { roomId: string },
            string[]
        >("rooms.messages", { roomId: "a" });
        const listener = vi.fn();
        resource.subscribe(listener);

        await resource.refetch();
        resource.dispose();
        FakeEventSource.instances[0]?.emit("klasp.invalidate", {
            topic: "room:a",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(requests).toHaveLength(1);
        expect(listener).toHaveBeenCalledTimes(3);
    });
});

function createFetch(
    responses: unknown[],
    requests: unknown[] = [],
): typeof fetch {
    return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        const response = responses.shift();

        if (!response) {
            throw new Error("No fake response queued.");
        }

        return new Response(JSON.stringify(response));
    }) as unknown as typeof fetch;
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const startedAt = Date.now();

    while (!predicate()) {
        if (Date.now() - startedAt > 250) {
            throw new Error("Timed out waiting for condition.");
        }

        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}
