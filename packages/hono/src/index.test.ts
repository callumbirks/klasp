import type { KlaspRealtimeAdapter } from "@klasp/core";
import { createKlasp } from "@klasp/server";
import { describe, expect, test } from "vitest";
import { klaspHandler } from "./index.js";

function createMemoryRealtimeAdapter(): KlaspRealtimeAdapter {
    return {
        async publishInvalidation() {},
        async subscribeInvalidations() {
            return async () => {};
        },
    };
}

describe("klaspHandler", () => {
    test("delegates POST /rpc to the Klasp RPC runtime", async () => {
        const klasp = createKlasp({});
        const api = klasp.router({
            echo: klasp.query({
                handler({ input }) {
                    return input;
                },
            }),
        });
        const app = klaspHandler({ klasp, api });

        const response = await app.request("/rpc", {
            method: "POST",
            body: JSON.stringify({
                version: 1,
                type: "query",
                path: "echo",
                input: { ok: true },
            }),
        });

        await expect(response.json()).resolves.toMatchObject({
            ok: true,
            data: { ok: true },
        });
    });

    test("delegates GET /events to the Klasp SSE runtime", async () => {
        const klasp = createKlasp({
            realtime: createMemoryRealtimeAdapter(),
        });
        const app = klaspHandler({ klasp, api: {} });
        const response = await app.request("/events?clientId=client");

        expect(response.headers.get("content-type")).toBe("text/event-stream");
        await expect(readText(response)).resolves.toContain("klasp.connected");
    });

    test("returns serialized BAD_REQUEST when events are missing clientId", async () => {
        const klasp = createKlasp({});
        const app = klaspHandler({ klasp, api: {} });
        const response = await app.request("/events");

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            ok: false,
            error: {
                code: "BAD_REQUEST",
            },
        });
    });
});

async function readText(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    const result = await reader?.read();

    if (!result || result.done) {
        return "";
    }

    return new TextDecoder().decode(result.value);
}
