import {
    KLASP_PROCEDURE_DESCRIPTOR,
    KlaspError,
    type KlaspErrorCode,
    type KlaspObservabilityEvent,
    type KlaspObserve,
    type KlaspProcedureDescriptor,
    type KlaspRpcRequest,
    type KlaspRpcResponse,
} from "@klasp/core";

export interface CreateKlaspClientOptions<
    TApi extends Record<string, unknown> = Record<string, unknown>,
> {
    endpoint: string;
    api?: TApi;
    fetch?: typeof fetch;
    clientId?: string;
    observe?: KlaspObserve;
}

export type KlaspQueryProcedure<
    TInput = unknown,
    TOutput = unknown,
> = KlaspProcedureDescriptor<"query", TInput, TOutput>;

export type KlaspMutationProcedure<
    TInput = unknown,
    TOutput = unknown,
> = KlaspProcedureDescriptor<"mutation", TInput, TOutput>;

export type KlaspProcedureInput<TProcedure> = TProcedure extends {
    readonly [KLASP_PROCEDURE_DESCRIPTOR]: true;
    readonly __input?: infer TInput;
}
    ? TInput
    : never;

export type KlaspProcedureOutput<TProcedure> = TProcedure extends {
    readonly [KLASP_PROCEDURE_DESCRIPTOR]: true;
    readonly __output?: infer TOutput;
}
    ? TOutput
    : never;

export type KlaspQueryStatus = "idle" | "loading" | "success" | "error";
export type KlaspConnectionStatus =
    | "idle"
    | "connecting"
    | "connected"
    | "error"
    | "closed";

export interface KlaspQueryResourceState<TData> {
    data: TData | undefined;
    error: Error | null;
    status: KlaspQueryStatus;
    isLoading: boolean;
    isError: boolean;
    isSuccess: boolean;
}

export type KlaspQueryResourceListener<TData> = (
    state: KlaspQueryResourceState<TData>,
) => void;

export interface KlaspQueryResource<TInput = unknown, TData = unknown> {
    readonly id: string;
    getSnapshot(): KlaspQueryResourceState<TData>;
    subscribe(listener: KlaspQueryResourceListener<TData>): () => void;
    refetch(): Promise<TData>;
    setInput(input: TInput): void;
    dispose(): void;
}

export interface CreateKlaspQueryResourceOptions {
    enabled?: boolean;
}

export interface KlaspInvalidationMessage {
    topic: string;
}

type KlaspQueryResourceRefetchReason = "manual" | "invalidation" | "reconnect";

export interface KlaspClient<
    _TApi extends Record<string, unknown> = Record<string, unknown>,
> {
    readonly clientId: string;
    query<TProcedure extends KlaspQueryProcedure>(
        procedure: TProcedure,
        input: KlaspProcedureInput<TProcedure>,
    ): Promise<KlaspProcedureOutput<TProcedure>>;
    query<TInput, TOutput>(path: string, input: TInput): Promise<TOutput>;
    mutation<TProcedure extends KlaspMutationProcedure>(
        procedure: TProcedure,
        input: KlaspProcedureInput<TProcedure>,
    ): Promise<KlaspProcedureOutput<TProcedure>>;
    mutation<TInput, TOutput>(path: string, input: TInput): Promise<TOutput>;
    createQueryResource<TProcedure extends KlaspQueryProcedure>(
        procedure: TProcedure,
        input: KlaspProcedureInput<TProcedure>,
        options?: CreateKlaspQueryResourceOptions,
    ): KlaspQueryResource<
        KlaspProcedureInput<TProcedure>,
        KlaspProcedureOutput<TProcedure>
    >;
    createQueryResource<TInput, TOutput>(
        path: string,
        input: TInput,
        options?: CreateKlaspQueryResourceOptions,
    ): KlaspQueryResource<TInput, TOutput>;
    connectEvents(onEvent: (event: MessageEvent) => void): () => void;
    connectInvalidations(
        onInvalidation: (event: KlaspInvalidationMessage) => void,
    ): () => void;
    subscribeConnection(
        listener: (status: KlaspConnectionStatus) => void,
    ): () => void;
    getConnectionStatus(): KlaspConnectionStatus;
    getResourceKey(
        procedure: string | KlaspQueryProcedure | KlaspMutationProcedure,
        input: unknown,
    ): string;
}

export function createKlaspClient<
    TApi extends Record<string, unknown> = Record<string, unknown>,
>(options: CreateKlaspClientOptions<TApi>): KlaspClient<TApi> {
    const fetchImpl = options.fetch ?? fetch;
    const clientId = options.clientId ?? createKlaspClientId();
    const procedurePaths = options.api
        ? createKlaspProcedurePathMap(options.api)
        : new WeakMap<object, string>();
    const resourcesById = new Map<
        string,
        {
            path: string;
            topics: string[];
            refresh: (
                reason: KlaspQueryResourceRefetchReason,
            ) => Promise<unknown>;
        }
    >();
    const resourcesByTopic = new Map<string, Set<string>>();
    const connectionListeners = new Set<
        (status: KlaspConnectionStatus) => void
    >();
    let connectionStatus: KlaspConnectionStatus = "idle";
    let hasOpenedEventsStream = false;
    let shouldRefreshLiveResourcesOnOpen = false;
    let reconnectRefreshQueued = false;

    const setConnectionStatus = (status: KlaspConnectionStatus) => {
        if (connectionStatus === status) {
            return;
        }

        connectionStatus = status;
        safeObserve(options.observe, {
            type: "client.connection.status",
            timestamp: Date.now(),
            clientId,
            status,
        });
        for (const listener of connectionListeners) {
            listener(connectionStatus);
        }
    };

    const rawCall = async <TInput, TOutput>(
        type: "query" | "mutation",
        path: string,
        input: TInput,
    ): Promise<KlaspRpcResponse<TOutput>> => {
        const startedAt = Date.now();
        safeObserve(options.observe, {
            type: "client.rpc.start",
            timestamp: startedAt,
            path,
            procedureType: type,
            clientId,
        });
        const request: KlaspRpcRequest<TInput> = {
            version: 1,
            type,
            path,
            input,
            clientId,
        };
        try {
            const response = await fetchImpl(`${options.endpoint}/rpc`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(request),
            });

            // Klasp protocol errors are serialized as RPC responses. Non-OK HTTP
            // responses mean the transport itself failed.
            if (!response.ok) {
                const message = `Klasp call failed: ${response.status}`;
                safeObserve(options.observe, {
                    type: "client.rpc.error",
                    timestamp: Date.now(),
                    path,
                    procedureType: type,
                    clientId,
                    durationMs: Date.now() - startedAt,
                    message,
                });
                throw new Error(message);
            }

            const rpcResponse =
                (await response.json()) as KlaspRpcResponse<TOutput>;

            if (rpcResponse.ok) {
                safeObserve(options.observe, {
                    type: "client.rpc.success",
                    timestamp: Date.now(),
                    path,
                    procedureType: type,
                    clientId,
                    durationMs: Date.now() - startedAt,
                    liveTopicCount: rpcResponse.live?.topics.length ?? 0,
                });
            } else {
                safeObserve(options.observe, {
                    type: "client.rpc.error",
                    timestamp: Date.now(),
                    path,
                    procedureType: type,
                    clientId,
                    durationMs: Date.now() - startedAt,
                    errorCode: rpcResponse.error.code,
                    message: rpcResponse.error.message,
                });
            }

            return rpcResponse;
        } catch (error) {
            if (
                error instanceof Error &&
                error.message.startsWith("Klasp call failed:")
            ) {
                throw error;
            }

            safeObserve(options.observe, {
                type: "client.rpc.error",
                timestamp: Date.now(),
                path,
                procedureType: type,
                clientId,
                durationMs: Date.now() - startedAt,
                message: toSafeClientErrorMessage(error),
            });
            throw error;
        }
    };

    const resolvePath = (
        procedure: string | KlaspQueryProcedure | KlaspMutationProcedure,
        type: "query" | "mutation",
    ): string => getKlaspProcedurePath(procedure, type, procedurePaths);

    const unregisterResource = (id: string) => {
        const previous = resourcesById.get(id);
        if (!previous) {
            return;
        }

        for (const topic of previous.topics) {
            const ids = resourcesByTopic.get(topic);
            ids?.delete(id);

            if (ids?.size === 0) {
                resourcesByTopic.delete(topic);
            }
        }

        resourcesById.delete(id);
        safeObserve(options.observe, {
            type: "client.resource.unregister",
            timestamp: Date.now(),
            clientId,
            resourceId: id,
            topics: previous.topics,
            topicCount: previous.topics.length,
        });
    };

    const registerResource = (
        id: string,
        path: string,
        topics: string[],
        refresh: (reason: KlaspQueryResourceRefetchReason) => Promise<unknown>,
    ) => {
        unregisterResource(id);

        if (topics.length === 0) {
            return;
        }

        resourcesById.set(id, {
            path,
            topics,
            refresh,
        });

        for (const topic of topics) {
            const ids = resourcesByTopic.get(topic) ?? new Set<string>();
            ids.add(id);
            resourcesByTopic.set(topic, ids);
        }
        safeObserve(options.observe, {
            type: "client.resource.register",
            timestamp: Date.now(),
            clientId,
            resourceId: id,
            path,
            topics,
            topicCount: topics.length,
        });
    };

    const invalidate = (topic: string) => {
        const resourceIds = resourcesByTopic.get(topic);
        safeObserve(options.observe, {
            type: "client.invalidation.received",
            timestamp: Date.now(),
            clientId,
            topic,
            matchedResourceCount: resourceIds?.size ?? 0,
        });

        if (!resourceIds) {
            return;
        }

        for (const resourceId of Array.from(resourceIds)) {
            const resource = resourcesById.get(resourceId);
            void resource?.refresh("invalidation");
        }
    };

    const refreshLiveResources = () => {
        for (const resource of Array.from(resourcesById.values())) {
            void resource.refresh("reconnect");
        }
    };

    const queueReconnectRefresh = () => {
        if (reconnectRefreshQueued) {
            return;
        }

        reconnectRefreshQueued = true;
        queueMicrotask(() => {
            reconnectRefreshQueued = false;
            refreshLiveResources();
        });
    };

    const handleEventsStreamOpen = () => {
        const shouldRefresh =
            hasOpenedEventsStream && shouldRefreshLiveResourcesOnOpen;

        hasOpenedEventsStream = true;
        shouldRefreshLiveResourcesOnOpen = false;
        setConnectionStatus("connected");

        if (shouldRefresh) {
            queueReconnectRefresh();
        }
    };

    const handleEventsStreamError = () => {
        if (hasOpenedEventsStream) {
            shouldRefreshLiveResourcesOnOpen = true;
        }

        setConnectionStatus("error");
    };

    const connectEvents = (onEvent: (event: MessageEvent) => void) => {
        setConnectionStatus("connecting");

        const source = new EventSource(
            `${options.endpoint}/events?clientId=${encodeURIComponent(clientId)}`,
        );

        source.addEventListener("open", handleEventsStreamOpen);
        source.addEventListener("error", handleEventsStreamError);
        source.addEventListener("klasp.connected", handleEventsStreamOpen);
        source.addEventListener("klasp.invalidate", onEvent);

        return () => {
            source.removeEventListener("open", handleEventsStreamOpen);
            source.removeEventListener("error", handleEventsStreamError);
            source.removeEventListener(
                "klasp.connected",
                handleEventsStreamOpen,
            );
            source.removeEventListener("klasp.invalidate", onEvent);
            source.close();
            if (hasOpenedEventsStream) {
                shouldRefreshLiveResourcesOnOpen = true;
            }
            setConnectionStatus("closed");
        };
    };

    const client: KlaspClient<TApi> = {
        clientId,

        async query<TInput, TOutput>(
            procedureOrPath: string | KlaspQueryProcedure<TInput, TOutput>,
            input: TInput,
        ): Promise<TOutput> {
            const path = resolvePath(procedureOrPath, "query");
            return unwrapKlaspResponse(await rawCall("query", path, input));
        },

        async mutation<TInput, TOutput>(
            procedureOrPath: string | KlaspMutationProcedure<TInput, TOutput>,
            input: TInput,
        ): Promise<TOutput> {
            const path = resolvePath(procedureOrPath, "mutation");
            return unwrapKlaspResponse(await rawCall("mutation", path, input));
        },

        createQueryResource<TInput, TOutput>(
            procedureOrPath: string | KlaspQueryProcedure<TInput, TOutput>,
            input: TInput,
            resourceOptions: CreateKlaspQueryResourceOptions = {},
        ): KlaspQueryResource<TInput, TOutput> {
            const path = resolvePath(procedureOrPath, "query");

            return createKlaspQueryResource({
                enabled: resourceOptions.enabled ?? true,
                input,
                path,
                rawQuery: (nextInput) =>
                    rawCall<TInput, TOutput>("query", path, nextInput),
                register: registerResource,
                unregister: unregisterResource,
                observe: options.observe,
                clientId,
            });
        },

        connectEvents,

        connectInvalidations(
            onInvalidation: (event: KlaspInvalidationMessage) => void,
        ) {
            return connectEvents((message) => {
                const event = parseKlaspInvalidationMessage(message);
                if (event) {
                    onInvalidation(event);
                }
            });
        },

        subscribeConnection(listener) {
            connectionListeners.add(listener);
            listener(connectionStatus);

            return () => {
                connectionListeners.delete(listener);
            };
        },

        getConnectionStatus() {
            return connectionStatus;
        },

        getResourceKey(procedure, input) {
            const type =
                typeof procedure === "string" || procedure.type === "query"
                    ? "query"
                    : "mutation";
            return createKlaspResourceKey(
                getKlaspProcedurePath(procedure, type, procedurePaths),
                input,
            );
        },
    };

    if (typeof EventSource !== "undefined") {
        client.connectInvalidations((event) => {
            invalidate(event.topic);
        });
    }

    return client;
}

function createKlaspClientId(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
        return crypto.randomUUID();
    }

    return `klasp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function createKlaspProcedurePathMap(api: Record<string, unknown>) {
    const paths = new WeakMap<object, string>();

    const visit = (value: unknown, segments: string[]) => {
        if (!value || typeof value !== "object") {
            return;
        }

        if (isKlaspProcedure(value)) {
            paths.set(value, segments.join("."));
            return;
        }

        if (Array.isArray(value)) {
            return;
        }

        for (const [key, child] of Object.entries(value)) {
            visit(child, [...segments, key]);
        }
    };

    visit(api, []);

    return paths;
}

export function getKlaspProcedurePath(
    procedure: string | KlaspQueryProcedure | KlaspMutationProcedure,
    type: "query" | "mutation",
    paths: WeakMap<object, string>,
): string {
    if (typeof procedure === "string") {
        return procedure;
    }

    if (procedure.type !== type) {
        throw new Error(
            `Expected a Klasp ${type} procedure, received a ${procedure.type} procedure.`,
        );
    }

    const path = paths.get(procedure);
    if (!path) {
        throw new Error(
            "Klasp procedure was not found in the provided api tree.",
        );
    }

    return path;
}

interface CreateInternalQueryResourceOptions<TInput, TData> {
    clientId: string;
    enabled?: boolean;
    input: TInput;
    observe: KlaspObserve | undefined;
    path: string;
    rawQuery(input: TInput): Promise<KlaspRpcResponse<TData>>;
    register(
        id: string,
        path: string,
        topics: string[],
        refresh: (reason: KlaspQueryResourceRefetchReason) => Promise<unknown>,
    ): void;
    unregister(id: string): void;
}

function createKlaspQueryResource<TInput, TData>({
    clientId,
    enabled = true,
    input,
    observe,
    path,
    rawQuery,
    register,
    unregister,
}: CreateInternalQueryResourceOptions<TInput, TData>): KlaspQueryResource<
    TInput,
    TData
> {
    let currentInput = input;
    let id = createKlaspResourceKey(path, currentInput);
    let disposed = false;
    let requestId = 0;
    let state = createKlaspQueryResourceState<TData>(
        undefined,
        null,
        enabled ? "loading" : "idle",
    );
    const listeners = new Set<KlaspQueryResourceListener<TData>>();

    const notify = () => {
        for (const listener of listeners) {
            listener(state);
        }
    };

    const setState = (
        data: TData | undefined,
        error: Error | null,
        status: KlaspQueryStatus,
    ) => {
        state = createKlaspQueryResourceState(data, error, status);
        notify();
    };

    const resource: KlaspQueryResource<TInput, TData> = {
        get id() {
            return id;
        },

        getSnapshot() {
            return state;
        },

        subscribe(listener) {
            if (disposed) {
                listener(state);
                return () => {};
            }

            listeners.add(listener);
            listener(state);

            return () => {
                listeners.delete(listener);
            };
        },

        async refetch(
            reason: KlaspQueryResourceRefetchReason = "manual",
        ): Promise<TData> {
            if (disposed) {
                throw new Error(
                    "Cannot refetch a disposed Klasp query resource.",
                );
            }

            const nextRequestId = requestId + 1;
            requestId = nextRequestId;
            const startedAt = Date.now();
            safeObserve(observe, {
                type: "client.resource.refetch",
                timestamp: startedAt,
                clientId,
                resourceId: id,
                path,
                reason,
                status: "start",
            });
            setState(state.data, null, "loading");

            try {
                const response = await rawQuery(currentInput);
                const data = unwrapKlaspResponse(response);

                if (disposed || nextRequestId !== requestId) {
                    return data;
                }

                setState(data, null, "success");
                register(id, path, response.live?.topics ?? [], (nextReason) =>
                    (
                        resource.refetch as (
                            reason: KlaspQueryResourceRefetchReason,
                        ) => Promise<TData>
                    )(nextReason),
                );
                safeObserve(observe, {
                    type: "client.resource.refetch",
                    timestamp: Date.now(),
                    clientId,
                    resourceId: id,
                    path,
                    reason,
                    status: "success",
                    durationMs: Date.now() - startedAt,
                });

                return data;
            } catch (error) {
                const nextError = toError(error);

                if (!disposed && nextRequestId === requestId) {
                    setState(state.data, nextError, "error");
                    unregister(id);
                }
                safeObserve(observe, {
                    type: "client.resource.refetch",
                    timestamp: Date.now(),
                    clientId,
                    resourceId: id,
                    path,
                    reason,
                    status: "error",
                    durationMs: Date.now() - startedAt,
                    ...toSafeClientErrorFields(nextError),
                });

                throw nextError;
            }
        },

        setInput(nextInput: TInput) {
            if (disposed) {
                return;
            }

            const previousId = id;
            currentInput = nextInput;
            id = createKlaspResourceKey(path, currentInput);

            if (previousId !== id) {
                unregister(previousId);
            }
        },

        dispose() {
            if (disposed) {
                return;
            }

            disposed = true;
            unregister(id);
            listeners.clear();
        },
    };

    return resource;
}

function createKlaspQueryResourceState<TData>(
    data: TData | undefined,
    error: Error | null,
    status: KlaspQueryStatus,
): KlaspQueryResourceState<TData> {
    return {
        data,
        error,
        status,
        isLoading: status === "loading",
        isError: status === "error",
        isSuccess: status === "success",
    };
}

export function isKlaspProcedure(
    value: object,
): value is KlaspQueryProcedure | KlaspMutationProcedure {
    return (
        "type" in value &&
        (value.type === "query" || value.type === "mutation") &&
        KLASP_PROCEDURE_DESCRIPTOR in value &&
        value[KLASP_PROCEDURE_DESCRIPTOR] === true
    );
}

export function parseKlaspInvalidationMessage(
    message: MessageEvent,
): KlaspInvalidationMessage | null {
    if (typeof message.data !== "string") {
        return null;
    }

    try {
        const data = JSON.parse(message.data) as unknown;
        if (
            data &&
            typeof data === "object" &&
            "topic" in data &&
            typeof data.topic === "string"
        ) {
            return { topic: data.topic };
        }
    } catch {
        return null;
    }

    return null;
}

export function unwrapKlaspResponse<TData>(
    response: KlaspRpcResponse<TData>,
): TData {
    if (response.ok) {
        return response.data;
    }

    throw new KlaspError(
        response.error.code,
        response.error.message,
        response.error.details,
    );
}

export function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export function createKlaspResourceKey(path: string, input: unknown): string {
    return `${path}:${stableSerialize(input)}`;
}

export function stableSerialize(value: unknown): string {
    try {
        return (
            JSON.stringify(value, (_key, child) => {
                if (!isPlainObject(child)) {
                    return child;
                }

                return Object.keys(child)
                    .sort()
                    .reduce<Record<string, unknown>>((result, key) => {
                        result[key] = (child as Record<string, unknown>)[key];
                        return result;
                    }, {});
            }) ?? "undefined"
        );
    } catch {
        return String(value);
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        Object.getPrototypeOf(value) === Object.prototype
    );
}

function toSafeClientErrorFields(error: unknown): {
    errorCode?: KlaspErrorCode;
    message: string;
} {
    if (error instanceof KlaspError) {
        return {
            errorCode: error.code,
            message: error.message,
        };
    }

    return {
        message: toSafeClientErrorMessage(error),
    };
}

function toSafeClientErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Klasp client error.";
}

function safeObserve(
    observe: KlaspObserve | undefined,
    event: KlaspObservabilityEvent,
): void {
    try {
        observe?.(event);
    } catch {
        // Observability must not change application behavior.
    }
}
