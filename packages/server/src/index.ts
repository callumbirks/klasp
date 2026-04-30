import type {
    KlaspInvalidationEvent,
    KlaspLiveConfig,
    KlaspRealtimeAdapter,
} from "@klasp/core";

export interface KlaspContext {
    [key: string]: unknown;
}

export interface CreateKlaspOptions<TContext extends KlaspContext> {
    auth?: (input: { request: Request }) => Promise<TContext> | TContext;
    realtime?: KlaspRealtimeAdapter;
}

export interface KlaspQueryDefinition<TInput, TOutput, TContext> {
    type: "query";
    parseInput?: (input: unknown) => TInput;
    handler: (input: {
        input: TInput;
        ctx: TContext;
        klasp: KlaspRuntime;
    }) => Promise<TOutput> | TOutput;
    live?: (input: { input: TInput; ctx: TContext }) => KlaspLiveConfig;
}

export interface KlaspMutationDefinition<TInput, TOutput, TContext> {
    type: "mutation";
    parseInput?: (input: unknown) => TInput;
    handler: (input: {
        input: TInput;
        ctx: TContext;
        klasp: KlaspRuntime;
    }) => Promise<TOutput> | TOutput;
}

export interface KlaspRuntime {
    invalidate(topic: string): Promise<void>;
}

export interface Klasp<TContext extends KlaspContext = KlaspContext> {
    query<TInput, TOutput>(
        definition: KlaspQueryDefinition<TInput, TOutput, TContext>,
    ): KlaspQueryDefinition<TInput, TOutput, TContext>;
    mutation<TInput, TOutput>(
        definition: KlaspMutationDefinition<TInput, TOutput, TContext>,
    ): KlaspMutationDefinition<TInput, TOutput, TContext>;
    router<TProcedures extends Record<string, unknown>>(
        procedures: TProcedures,
    ): TProcedures;
    createContext(request: Request): Promise<TContext>;
    runtime: KlaspRuntime;
    realtime: KlaspRealtimeAdapter | undefined;
}

export const KLASP_EVENTS_HEADERS = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
} as const satisfies HeadersInit;

export type KlaspEventsHeaders = typeof KLASP_EVENTS_HEADERS;

export interface CreateKlaspEventsStreamOptions {
    realtime: KlaspRealtimeAdapter | undefined;
    signal?: AbortSignal;
    heartbeatMs?: number;
    now?: () => number;
}

export interface KlaspEventsStream {
    stream: ReadableStream<Uint8Array>;
    headers: KlaspEventsHeaders;
}

export function createKlaspEventsStream(
    options: CreateKlaspEventsStreamOptions,
): KlaspEventsStream {
    const encoder = new TextEncoder();
    const heartbeatMs = options.heartbeatMs ?? 30_000;
    const now = options.now ?? Date.now;
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let removeAbortListener: (() => void) | undefined;
    let unsubscribe: (() => Promise<void>) | undefined;
    let cleanup: (() => Promise<void>) | undefined;

    const stream = new ReadableStream<Uint8Array>({
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
                enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

            if (options.signal) {
                options.signal.addEventListener("abort", handleAbort);
                removeAbortListener = () => {
                    options.signal?.removeEventListener("abort", handleAbort);
                };
            }

            write("klasp.connected", {
                timestamp: now(),
            });

            heartbeat = setInterval(() => {
                writeComment("heartbeat");
            }, heartbeatMs);

            unsubscribe = await options.realtime?.subscribeInvalidations(
                (event: KlaspInvalidationEvent) => {
                    write("klasp.invalidate", event);
                },
            );

            if (options.signal?.aborted) {
                void cleanup();
            }
        },
        cancel() {
            void cleanup?.();
        },
    });

    return {
        stream,
        headers: KLASP_EVENTS_HEADERS,
    };
}

export interface CreateKlaspEventsResponseOptions {
    klasp: Klasp;
    request: Request;
    heartbeatMs?: number;
    now?: () => number;
}

export async function createKlaspEventsResponse(
    options: CreateKlaspEventsResponseOptions,
): Promise<Response> {
    await options.klasp.createContext(options.request);

    const streamOptions: CreateKlaspEventsStreamOptions = {
        realtime: options.klasp.realtime,
        signal: options.request.signal,
    };

    if (options.heartbeatMs !== undefined) {
        streamOptions.heartbeatMs = options.heartbeatMs;
    }

    if (options.now !== undefined) {
        streamOptions.now = options.now;
    }

    const events = createKlaspEventsStream(streamOptions);

    return new Response(events.stream, {
        headers: events.headers,
    });
}

export function createKlasp<TContext extends KlaspContext = KlaspContext>(
    options: CreateKlaspOptions<TContext>,
): Klasp<TContext> {
    const runtime: KlaspRuntime = {
        async invalidate(topic: string) {
            await options.realtime?.publishInvalidation(topic);
        },
    };

    return {
        query<TInput, TOutput>(
            definition: Omit<
                KlaspQueryDefinition<TInput, TOutput, TContext>,
                "type"
            >,
        ): KlaspQueryDefinition<TInput, TOutput, TContext> {
            return {
                type: "query",
                ...definition,
            };
        },

        mutation<TInput, TOutput>(
            definition: Omit<
                KlaspMutationDefinition<TInput, TOutput, TContext>,
                "type"
            >,
        ): KlaspMutationDefinition<TInput, TOutput, TContext> {
            return {
                type: "mutation",
                ...definition,
            };
        },

        router<TProcedures extends Record<string, unknown>>(
            procedures: TProcedures,
        ): TProcedures {
            return procedures;
        },

        async createContext(request: Request): Promise<TContext> {
            if (!options.auth) {
                return {} as TContext;
            }

            return options.auth({ request });
        },

        runtime,
        realtime: options.realtime,
    };
}
