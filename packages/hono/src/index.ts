import type {
    KlaspInvalidationEvent,
    KlaspRpcRequest,
    KlaspRpcResponse,
} from "@klasp/core";
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

    app.get("/events", async (c) => {
        await options.klasp.createContext(c.req.raw);

        const encoder = new TextEncoder();
        let closed = false;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let removeAbortListener: (() => void) | undefined;
        let unsubscribe: (() => Promise<void>) | undefined;
        let cleanup: (() => Promise<void>) | undefined;

        const stream = new ReadableStream({
            async start(controller) {
                const enqueue = (chunk: string) => {
                    if (closed) {
                        return;
                    }

                    try {
                        controller.enqueue(encoder.encode(chunk));
                    } catch {
                        void cleanup?.();
                    }
                };

                const write = (event: string, data: unknown) => {
                    enqueue(
                        `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                    );
                };

                const writeComment = (comment: string) => {
                    enqueue(`: ${comment}\n\n`);
                };

                cleanup = async () => {
                    if (closed) {
                        return;
                    }

                    closed = true;

                    if (heartbeat) {
                        clearInterval(heartbeat);
                    }

                    removeAbortListener?.();
                    await unsubscribe?.();

                    try {
                        controller.close();
                    } catch {
                        // The stream may already be closed by the runtime.
                    }
                };

                const handleAbort = () => {
                    void cleanup?.();
                };

                c.req.raw.signal.addEventListener("abort", handleAbort);
                removeAbortListener = () => {
                    c.req.raw.signal.removeEventListener("abort", handleAbort);
                };

                write("klasp.connected", {
                    timestamp: Date.now(),
                });

                heartbeat = setInterval(() => {
                    writeComment("heartbeat");
                }, 30_000);

                unsubscribe =
                    await options.klasp.realtime?.subscribeInvalidations(
                        (event: KlaspInvalidationEvent) => {
                            write("klasp.invalidate", event);
                        },
                    );
            },
            cancel() {
                void cleanup?.();
            },
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
            },
        });
    });

    return app;
}
