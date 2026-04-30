import type { KlaspRpcRequest, KlaspRpcResponse } from "@klasp/core";
import {
    createKlaspEventsResponse,
    type Klasp,
    type KlaspMutationDefinition,
    type KlaspQueryDefinition,
} from "@klasp/server";
import { Hono } from "hono";

export interface KlaspHonoHandlerOptions {
    klasp: Klasp;
    api: Record<
        string,
        | KlaspQueryDefinition<unknown, unknown, unknown>
        | KlaspMutationDefinition<unknown, unknown, unknown>
    >;
}

export function klaspHandler(options: KlaspHonoHandlerOptions): Hono {
    const app = new Hono();

    app.post("/rpc", async (c) => {
        const request = await c.req.json<KlaspRpcRequest<unknown>>();
        const procedure = options.api[request.path];

        if (!procedure) {
            return c.json<KlaspRpcResponse<unknown>>(
                {
                    ok: false,
                    data: undefined,
                    live: undefined,
                    error: {
                        code: "NOT_FOUND",
                        message: `Procedure '${request.path}' was not found.`,
                    },
                },
                404,
            );
        }

        const rawInput = await c.req.json().catch(() => undefined);
        const input = procedure.parseInput
            ? procedure.parseInput(rawInput)
            : rawInput;

        const ctx = await options.klasp.createContext(c.req.raw);

        const result = await procedure.handler({
            input,
            ctx,
            klasp: options.klasp.runtime,
        });

        const live =
            procedure.type === "query" && procedure.live
                ? procedure.live({ input, ctx })
                : undefined;

        return c.json<KlaspRpcResponse<unknown>>({
            ok: true,
            data: result,
            live,
            error: undefined,
        });
    });

    app.get("/events", (c) =>
        createKlaspEventsResponse({
            klasp: options.klasp,
            request: c.req.raw,
        }),
    );

    return app;
}
