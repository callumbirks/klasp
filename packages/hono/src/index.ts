import type {
    Klasp,
    KlaspMutationDefinition,
    KlaspQueryDefinition,
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

    app.post("/call/:procedure", async (c) => {
        const procedureName = c.req.param("procedure");
        const procedure = options.api[procedureName];

        if (!procedure) {
            return c.json(
                {
                    error: {
                        code: "NOT_FOUND",
                        message: `Procedure '${procedureName}' was not found.`,
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

        return c.json({
            data: result,
            live,
        });
    });

    app.get("/events", async (c) => {
        const stream = new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();

                const write = (event: string, data: unknown) => {
                    controller.enqueue(
                        encoder.encode(
                            `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                        ),
                    );
                };

                write("klasp.connected", {
                    timestamp: Date.now(),
                });

                // Real implementation needs cleanup when request aborts.
            },
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            },
        });
    });

    return app;
}
