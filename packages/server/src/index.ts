import {
    KLASP_PROCEDURE_DESCRIPTOR,
    KlaspError,
    type KlaspInvalidationEvent,
    type KlaspLiveConfig,
    type KlaspProcedureDescriptor,
    type KlaspRealtimeAdapter,
    type KlaspRouterContract,
    type KlaspRpcRequest,
    type KlaspRpcResponse,
} from "@klasp/core";

export interface KlaspContext {
    [key: string]: unknown;
}

export interface CreateKlaspOptions<TContext extends KlaspContext> {
    auth?: (input: { request: Request }) => Promise<TContext> | TContext;
    realtime?: KlaspRealtimeAdapter;
}

export interface KlaspQueryDefinition<TInput, TOutput, TContext>
    extends KlaspProcedureDescriptor<"query", TInput, TOutput> {
    type: "query";
    parseInput?: (input: unknown) => TInput;
    handler: (input: {
        input: TInput;
        ctx: TContext;
        klasp: KlaspRuntime;
    }) => Promise<TOutput> | TOutput;
    live?: (input: { input: TInput; ctx: TContext }) => KlaspLiveConfig;
}

export interface KlaspMutationDefinition<TInput, TOutput, TContext>
    extends KlaspProcedureDescriptor<"mutation", TInput, TOutput> {
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

export type KlaspQueryOptions<TInput, TOutput, TContext> = Omit<
    KlaspQueryDefinition<TInput, TOutput, TContext>,
    "type" | typeof KLASP_PROCEDURE_DESCRIPTOR
> & {
    type?: "query";
};

export type KlaspMutationOptions<TInput, TOutput, TContext> = Omit<
    KlaspMutationDefinition<TInput, TOutput, TContext>,
    "type" | typeof KLASP_PROCEDURE_DESCRIPTOR
> & {
    type?: "mutation";
};

export type KlaspRouterImplementation<TContract, TContext> =
    TContract extends KlaspProcedureDescriptor<
        infer TType,
        infer TInput,
        infer TOutput
    >
        ? TType extends "query"
            ? KlaspQueryDefinition<TInput, TOutput, TContext>
            : KlaspMutationDefinition<TInput, TOutput, TContext>
        : TContract extends Record<string, unknown>
          ? {
                [TKey in keyof TContract]: KlaspRouterImplementation<
                    TContract[TKey],
                    TContext
                >;
            }
          : never;

export interface Klasp<TContext extends KlaspContext = KlaspContext> {
    query<TInput, TOutput>(
        definition: KlaspQueryOptions<TInput, TOutput, TContext>,
    ): KlaspQueryDefinition<TInput, TOutput, TContext>;
    mutation<TInput, TOutput>(
        definition: KlaspMutationOptions<TInput, TOutput, TContext>,
    ): KlaspMutationDefinition<TInput, TOutput, TContext>;
    router<TContract extends KlaspRouterContract>(
        procedures: KlaspRouterImplementation<TContract, TContext>,
    ): KlaspRouterImplementation<TContract, TContext>;
    router<TProcedures extends Record<string, unknown>>(
        procedures: TProcedures,
    ): TProcedures;
    createContext(request: Request): Promise<TContext>;
    runtime: KlaspRuntime;
    realtime: KlaspRealtimeAdapter | undefined;
}

export type KlaspProcedureDefinition =
    | KlaspQueryDefinition<unknown, unknown, unknown>
    | KlaspMutationDefinition<unknown, unknown, unknown>;

export type KlaspApi = Record<string, unknown>;

export interface CreateKlaspRpcResponseOptions {
    klasp: Klasp;
    api: KlaspApi;
    request: Request;
}

export const KLASP_EVENTS_HEADERS = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
} as const satisfies HeadersInit;

export type KlaspEventsHeaders = typeof KLASP_EVENTS_HEADERS;

const KLASP_JSON_HEADERS = {
    "Content-Type": "application/json",
} as const satisfies HeadersInit;

const apiProcedureMapCache = new WeakMap<
    KlaspApi,
    ReadonlyMap<string, KlaspProcedureDefinition>
>();

function createJsonResponse(
    body: KlaspRpcResponse<unknown>,
    status = 200,
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: KLASP_JSON_HEADERS,
    });
}

export async function createKlaspRpcResponse(
    options: CreateKlaspRpcResponseOptions,
): Promise<Response> {
    const request = (await options.request.json()) as KlaspRpcRequest<unknown>;
    const procedure = getKlaspApiProcedureMap(options.api).get(request.path);

    if (!procedure) {
        return createJsonResponse({
            ok: false,
            data: undefined,
            live: undefined,
            error: {
                code: "NOT_FOUND",
                message: `Procedure '${request.path}' was not found.`,
            },
        });
    }

    if (request.type !== procedure.type) {
        return createJsonResponse({
            ok: false,
            data: undefined,
            live: undefined,
            error: {
                code: "BAD_REQUEST",
                message: `Procedure '${request.path}' is a ${procedure.type} but the request is a ${request.type}.`,
            },
        });
    }

    try {
        const input = procedure.parseInput
            ? procedure.parseInput(request.input)
            : request.input;

        const ctx = await options.klasp.createContext(options.request);

        const result = await procedure.handler({
            input,
            ctx,
            klasp: options.klasp.runtime,
        });

        const live =
            procedure.type === "query" && procedure.live
                ? procedure.live({ input, ctx })
                : undefined;

        return createJsonResponse({
            ok: true,
            data: result,
            live,
            error: undefined,
        });
    } catch (error) {
        if (error instanceof KlaspError) {
            return createJsonResponse({
                ok: false,
                data: undefined,
                live: undefined,
                error: {
                    code: error.code,
                    message: error.message,
                    details: error.details,
                },
            });
        }
        return createJsonResponse({
            ok: false,
            data: undefined,
            live: undefined,
            error: {
                code: "INTERNAL_SERVER_ERROR",
                message: `Internal server error: ${error}`,
            },
        });
    }
}

function getKlaspApiProcedureMap(
    api: KlaspApi,
): ReadonlyMap<string, KlaspProcedureDefinition> {
    const cached = apiProcedureMapCache.get(api);

    if (cached) {
        return cached;
    }

    const procedures = new Map<string, KlaspProcedureDefinition>();

    visitKlaspApiTree(api, [], procedures);
    apiProcedureMapCache.set(api, procedures);

    return procedures;
}

function visitKlaspApiTree(
    value: unknown,
    segments: string[],
    procedures: Map<string, KlaspProcedureDefinition>,
): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return;
    }

    if (isKlaspProcedureDefinition(value)) {
        procedures.set(segments.join("."), value);
        return;
    }

    for (const [key, child] of Object.entries(value)) {
        visitKlaspApiTree(child, [...segments, key], procedures);
    }
}

function isKlaspProcedureDefinition(
    value: object,
): value is KlaspProcedureDefinition {
    if (!(KLASP_PROCEDURE_DESCRIPTOR in value)) {
        return false;
    }

    const procedure = value as {
        readonly [KLASP_PROCEDURE_DESCRIPTOR]: unknown;
        readonly type?: unknown;
    };

    return (
        procedure[KLASP_PROCEDURE_DESCRIPTOR] === true &&
        (procedure.type === "query" || procedure.type === "mutation")
    );
}

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
            definition: KlaspQueryOptions<TInput, TOutput, TContext>,
        ): KlaspQueryDefinition<TInput, TOutput, TContext> {
            return {
                [KLASP_PROCEDURE_DESCRIPTOR]: true,
                type: "query",
                ...definition,
            };
        },

        mutation<TInput, TOutput>(
            definition: KlaspMutationOptions<TInput, TOutput, TContext>,
        ): KlaspMutationDefinition<TInput, TOutput, TContext> {
            return {
                [KLASP_PROCEDURE_DESCRIPTOR]: true,
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
