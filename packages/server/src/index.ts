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

type MaybePromise<T> = T | Promise<T>;

export type KlaspInputParser<TInput> =
    | ((input: unknown) => MaybePromise<TInput>)
    | {
          parse(input: unknown): MaybePromise<TInput>;
      }
    | {
          parseAsync(input: unknown): Promise<TInput>;
      }
    | {
          safeParse(input: unknown): MaybePromise<KlaspSafeParseResult<TInput>>;
      }
    | {
          safeParseAsync(input: unknown): Promise<KlaspSafeParseResult<TInput>>;
      }
    | {
          "~standard": {
              validate(
                  input: unknown,
              ): MaybePromise<KlaspStandardSchemaResult<TInput>>;
          };
      };

export type KlaspSafeParseResult<TInput> =
    | {
          success: true;
          data: TInput;
      }
    | {
          success: false;
          error: unknown;
      };

export type KlaspStandardSchemaResult<TInput> =
    | {
          value: TInput;
      }
    | {
          issues: readonly unknown[];
      };

export type InferKlaspInput<TInputParser> = TInputParser extends (
    input: unknown,
) => infer TInput
    ? Awaited<TInput>
    : TInputParser extends { parse(input: unknown): infer TInput }
      ? Awaited<TInput>
      : TInputParser extends { parseAsync(input: unknown): infer TInput }
        ? Awaited<TInput>
        : TInputParser extends {
                safeParseAsync(input: unknown): infer TResult;
            }
          ? Awaited<TResult> extends KlaspSafeParseResult<infer TInput>
              ? TInput
              : never
          : TInputParser extends { safeParse(input: unknown): infer TResult }
            ? Awaited<TResult> extends KlaspSafeParseResult<infer TInput>
                ? TInput
                : never
            : TInputParser extends {
                    "~standard": {
                        validate(input: unknown): infer TResult;
                    };
                }
              ? Awaited<TResult> extends KlaspStandardSchemaResult<infer TInput>
                  ? TInput
                  : never
              : never;

export interface KlaspQueryDefinition<TInput, TOutput, TContext>
    extends KlaspProcedureDescriptor<"query", TInput, TOutput> {
    type: "query";
    input?: KlaspInputParser<TInput>;
    handler(input: {
        input: TInput;
        ctx: TContext;
        klasp: KlaspRuntime;
    }): Promise<TOutput> | TOutput;
    live?(input: { input: TInput; ctx: TContext }): KlaspLiveConfig;
}

export interface KlaspMutationDefinition<TInput, TOutput, TContext>
    extends KlaspProcedureDescriptor<"mutation", TInput, TOutput> {
    type: "mutation";
    input?: KlaspInputParser<TInput>;
    handler(input: {
        input: TInput;
        ctx: TContext;
        klasp: KlaspRuntime;
    }): Promise<TOutput> | TOutput;
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
    query<TInputParser extends KlaspInputParser<unknown>, TOutput>(
        definition: KlaspQueryOptions<
            InferKlaspInput<TInputParser>,
            TOutput,
            TContext
        > & {
            input: TInputParser;
        },
    ): KlaspQueryDefinition<InferKlaspInput<TInputParser>, TOutput, TContext>;
    query<TInput, TOutput>(
        definition: KlaspQueryOptions<TInput, TOutput, TContext>,
    ): KlaspQueryDefinition<TInput, TOutput, TContext>;
    mutation<TInputParser extends KlaspInputParser<unknown>, TOutput>(
        definition: KlaspMutationOptions<
            InferKlaspInput<TInputParser>,
            TOutput,
            TContext
        > & {
            input: TInputParser;
        },
    ): KlaspMutationDefinition<
        InferKlaspInput<TInputParser>,
        TOutput,
        TContext
    >;
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
    sessions: KlaspSessionStore;
}

export interface KlaspSession {
    clientId: string;
    close(): void;
}

export interface KlaspSessionStore {
    connect(clientId: string): KlaspSession;
    authorizeTopics(clientId: string | undefined, topics: string[]): void;
    isAuthorized(clientId: string, topic: string): boolean;
}

export type KlaspProcedureDefinition =
    | KlaspQueryDefinition<unknown, unknown, unknown>
    | KlaspMutationDefinition<unknown, unknown, unknown>;

export type KlaspApi = {
    readonly [key: string]: KlaspProcedureDefinition | KlaspApi;
};

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
        const input = await parseKlaspProcedureInput(
            procedure.input,
            request.input,
        );

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

        if (procedure.type === "query" && live?.topics.length) {
            options.klasp.sessions.authorizeTopics(
                request.clientId,
                live.topics,
            );
        }

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

async function parseKlaspProcedureInput<TInput>(
    parser: KlaspInputParser<TInput> | undefined,
    input: unknown,
): Promise<TInput> {
    if (!parser) {
        return input as TInput;
    }

    try {
        if (typeof parser === "function") {
            return await parser(input);
        }

        if ("~standard" in parser) {
            const result = await parser["~standard"].validate(input);

            if ("value" in result) {
                return result.value;
            }

            throw createInputValidationError(result.issues);
        }

        if ("safeParseAsync" in parser) {
            const result = await parser.safeParseAsync(input);

            if (result.success) {
                return result.data;
            }

            throw createInputValidationError(getValidationIssues(result.error));
        }

        if ("safeParse" in parser) {
            const result = await parser.safeParse(input);

            if (result.success) {
                return result.data;
            }

            throw createInputValidationError(getValidationIssues(result.error));
        }

        if ("parseAsync" in parser) {
            return await parser.parseAsync(input);
        }

        return await parser.parse(input);
    } catch (error) {
        if (error instanceof KlaspError) {
            throw error;
        }

        throw createInputValidationError(getValidationIssues(error));
    }
}

function createInputValidationError(issues: unknown): KlaspError {
    return new KlaspError("VALIDATION_ERROR", "Invalid procedure input.", {
        issues,
    });
}

function getValidationIssues(error: unknown): unknown {
    if (
        error &&
        typeof error === "object" &&
        "issues" in error &&
        Array.isArray(error.issues)
    ) {
        return error.issues;
    }

    return error;
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
    isAuthorized?: (event: KlaspInvalidationEvent) => boolean;
    onClose?: () => void;
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
                options.onClose?.();

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
                    if (options.isAuthorized?.(event) ?? true) {
                        write("klasp.invalidate", event);
                    }
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
    const clientId = getKlaspEventsClientId(options.request);

    if (!clientId) {
        return createJsonResponse(
            {
                ok: false,
                data: undefined,
                live: undefined,
                error: {
                    code: "BAD_REQUEST",
                    message:
                        "Klasp events requests require a non-empty clientId query parameter.",
                },
            },
            400,
        );
    }

    await options.klasp.createContext(options.request);

    const session = options.klasp.sessions.connect(clientId);
    const streamOptions: CreateKlaspEventsStreamOptions = {
        realtime: options.klasp.realtime,
        isAuthorized: (event) =>
            options.klasp.sessions.isAuthorized(clientId, event.topic),
        onClose: () => {
            session.close();
        },
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

function getKlaspEventsClientId(request: Request): string | null {
    const clientId = new URL(request.url).searchParams.get("clientId")?.trim();
    return clientId || null;
}

export function createKlasp<TContext extends KlaspContext = KlaspContext>(
    options: CreateKlaspOptions<TContext>,
): Klasp<TContext> {
    const sessions = createKlaspSessionStore();
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
        sessions,
    };
}

function createKlaspSessionStore(): KlaspSessionStore {
    const sessions = new Map<
        string,
        {
            connection: symbol;
            topics: Set<string>;
        }
    >();

    return {
        connect(clientId: string): KlaspSession {
            const connection = Symbol(clientId);
            const existing = sessions.get(clientId);
            const topics = existing?.topics ?? new Set<string>();

            sessions.set(clientId, {
                connection,
                topics,
            });

            return {
                clientId,
                close() {
                    const active = sessions.get(clientId);

                    if (active?.connection === connection) {
                        sessions.delete(clientId);
                    }
                },
            };
        },

        authorizeTopics(clientId: string | undefined, topics: string[]) {
            if (!clientId) {
                return;
            }

            const session = sessions.get(clientId);
            if (!session) {
                return;
            }

            for (const topic of topics) {
                session.topics.add(topic);
            }
        },

        isAuthorized(clientId: string, topic: string): boolean {
            return sessions.get(clientId)?.topics.has(topic) ?? false;
        },
    };
}
