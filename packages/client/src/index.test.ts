import { afterEach, describe, expect, test, vi } from "vitest";
import { createKlaspClient } from "./index.js";

class FakeEventSource {
    static urls: string[] = [];

    constructor(public readonly url: string) {
        FakeEventSource.urls.push(url);
    }

    addEventListener() {}

    close() {}
}

describe("createKlaspClient client ids", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        FakeEventSource.urls = [];
    });

    test("includes the client id in RPC requests", async () => {
        const requests: unknown[] = [];
        const fetch = vi.fn(
            async (_url: RequestInfo | URL, init?: RequestInit) => {
                requests.push(JSON.parse(String(init?.body)));

                return new Response(
                    JSON.stringify({
                        ok: true,
                        data: null,
                        live: undefined,
                        error: undefined,
                    }),
                );
            },
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
    });

    test("connects events with the same client id", () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const client = createKlaspClient({
            endpoint: "http://localhost/klasp",
            fetch: vi.fn() as unknown as typeof fetch,
            clientId: "test-client",
        });

        client.connectEvents(() => {});

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
});
