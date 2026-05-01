import {
    type CreateKlaspClientOptions,
    createKlaspClient,
} from "@klasp/client";
import { KlaspError, type KlaspRpcResponse } from "@klasp/core";
import {
    createContext,
    createElement,
    type ReactElement,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
} from "react";

export type KlaspQueryStatus = "idle" | "loading" | "success" | "error";
export type KlaspMutationStatus = "idle" | "loading" | "success" | "error";

export interface KlaspProviderProps<TApi extends Record<string, unknown>> {
    api: TApi;
    endpoint: string;
    fetch?: CreateKlaspClientOptions["fetch"];
    children: ReactNode;
}

export interface UseKlaspQueryOptions {
    enabled?: boolean;
}

export interface UseKlaspQueryResult<TData> {
    data: TData | undefined;
    error: Error | null;
    status: KlaspQueryStatus;
    isLoading: boolean;
    isError: boolean;
    isSuccess: boolean;
    refetch: () => Promise<TData>;
}

export interface UseKlaspMutationResult<TInput, TData> {
    data: TData | undefined;
    error: Error | null;
    status: KlaspMutationStatus;
    isLoading: boolean;
    isError: boolean;
    isSuccess: boolean;
    mutate: (input: TInput) => Promise<TData>;
    reset: () => void;
}

export type KlaspQueryProcedure = {
    type: "query";
    handler: unknown;
};

export type KlaspMutationProcedure = {
    type: "mutation";
    handler: unknown;
};

export type KlaspProcedureInput<TProcedure> = TProcedure extends {
    handler: (args: infer TArgs) => unknown;
}
    ? TArgs extends { input: infer TInput }
        ? TInput
        : never
    : never;

export type KlaspProcedureOutput<TProcedure> = TProcedure extends {
    handler: (args: infer _TArgs) => infer TResult;
}
    ? Awaited<TResult>
    : never;

interface QueryResource {
    id: string;
    topics: string[];
    refresh: () => Promise<unknown>;
}

interface KlaspReactContextValue {
    client: ReturnType<typeof createKlaspClient>;
    getProcedurePath: (
        procedure: string | KlaspQueryProcedure | KlaspMutationProcedure,
        type: "query" | "mutation",
    ) => string;
    registerQueryResource: (resource: QueryResource) => void;
    unregisterQueryResource: (id: string) => void;
}

const KlaspReactContext = createContext<KlaspReactContextValue | null>(null);

export function KlaspProvider<TApi extends Record<string, unknown>>({
    api,
    endpoint,
    fetch,
    children,
}: KlaspProviderProps<TApi>): ReactElement {
    const procedurePaths = useMemo(() => createProcedurePathMap(api), [api]);
    const resourcesByIdRef = useRef(new Map<string, QueryResource>());
    const resourcesByTopicRef = useRef(new Map<string, Set<string>>());

    const client = useMemo(() => {
        if (fetch) {
            return createKlaspClient({ endpoint, fetch });
        }

        return createKlaspClient({ endpoint });
    }, [endpoint, fetch]);

    const unregisterQueryResource = useCallback((id: string) => {
        const previous = resourcesByIdRef.current.get(id);
        if (!previous) {
            return;
        }

        for (const topic of previous.topics) {
            const ids = resourcesByTopicRef.current.get(topic);
            ids?.delete(id);

            if (ids?.size === 0) {
                resourcesByTopicRef.current.delete(topic);
            }
        }

        resourcesByIdRef.current.delete(id);
    }, []);

    const registerQueryResource = useCallback(
        (resource: QueryResource) => {
            unregisterQueryResource(resource.id);
            resourcesByIdRef.current.set(resource.id, resource);

            for (const topic of resource.topics) {
                const ids =
                    resourcesByTopicRef.current.get(topic) ?? new Set<string>();
                ids.add(resource.id);
                resourcesByTopicRef.current.set(topic, ids);
            }
        },
        [unregisterQueryResource],
    );

    const getProcedurePath = useCallback(
        (
            procedure: string | KlaspQueryProcedure | KlaspMutationProcedure,
            type: "query" | "mutation",
        ): string => {
            if (typeof procedure === "string") {
                return procedure;
            }

            if (procedure.type !== type) {
                throw new Error(
                    `Expected a Klasp ${type} procedure, received a ${procedure.type} procedure.`,
                );
            }

            const path = procedurePaths.get(procedure);
            if (!path) {
                throw new Error(
                    "Klasp procedure was not found in the KlaspProvider api tree.",
                );
            }

            return path;
        },
        [procedurePaths],
    );

    useEffect(() => {
        return client.connectEvents((message) => {
            const event = parseInvalidationEvent(message);
            if (!event) {
                return;
            }

            const resourceIds = resourcesByTopicRef.current.get(event.topic);
            if (!resourceIds) {
                return;
            }

            for (const resourceId of resourceIds) {
                const resource = resourcesByIdRef.current.get(resourceId);
                void resource?.refresh();
            }
        });
    }, [client]);

    const value = useMemo<KlaspReactContextValue>(
        () => ({
            client,
            getProcedurePath,
            registerQueryResource,
            unregisterQueryResource,
        }),
        [
            client,
            getProcedurePath,
            registerQueryResource,
            unregisterQueryResource,
        ],
    );

    return createElement(KlaspReactContext.Provider, { value }, children);
}

export function useKlaspQuery<TProcedure extends KlaspQueryProcedure>(
    procedure: TProcedure,
    input: KlaspProcedureInput<TProcedure>,
    options?: UseKlaspQueryOptions,
): UseKlaspQueryResult<KlaspProcedureOutput<TProcedure>>;
export function useKlaspQuery<TInput, TData>(
    path: string,
    input: TInput,
    options?: UseKlaspQueryOptions,
): UseKlaspQueryResult<TData>;
export function useKlaspQuery<TData>(
    procedureOrPath: string | KlaspQueryProcedure,
    input: unknown,
    options: UseKlaspQueryOptions = {},
): UseKlaspQueryResult<TData> {
    const context = useRequiredKlaspContext();
    const path = context.getProcedurePath(procedureOrPath, "query");
    const resourceId = useId();
    const inputKey = stableSerialize(input);
    const enabled = options.enabled ?? true;
    const queryVersion = enabled ? inputKey : null;
    const latestInputRef = useRef(input);
    const mountedRef = useRef(false);
    const requestIdRef = useRef(0);
    const [state, setState] = useState<{
        data: TData | undefined;
        error: Error | null;
        status: KlaspQueryStatus;
    }>({
        data: undefined,
        error: null,
        status: enabled ? "loading" : "idle",
    });

    latestInputRef.current = input;

    useEffect(() => {
        mountedRef.current = true;

        return () => {
            mountedRef.current = false;
        };
    }, []);

    const refetch = useCallback(async (): Promise<TData> => {
        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;

        setState((previous) => ({
            data: previous.data,
            error: null,
            status: "loading",
        }));

        try {
            const response = (await context.client.query(
                path,
                latestInputRef.current,
            )) as KlaspRpcResponse<TData>;
            const data = unwrapKlaspResponse(response);

            if (mountedRef.current && requestId === requestIdRef.current) {
                setState({
                    data,
                    error: null,
                    status: "success",
                });

                if (response.live?.topics.length) {
                    context.registerQueryResource({
                        id: resourceId,
                        topics: response.live.topics,
                        refresh: refetch,
                    });
                } else {
                    context.unregisterQueryResource(resourceId);
                }
            }

            return data;
        } catch (error) {
            const nextError = toError(error);

            if (mountedRef.current && requestId === requestIdRef.current) {
                setState((previous) => ({
                    data: previous.data,
                    error: nextError,
                    status: "error",
                }));
                context.unregisterQueryResource(resourceId);
            }

            throw nextError;
        }
    }, [context, path, resourceId]);

    useEffect(() => {
        if (queryVersion === null) {
            setState((previous) => ({
                data: previous.data,
                error: null,
                status: "idle",
            }));
            context.unregisterQueryResource(resourceId);
            return;
        }

        void refetch().catch(() => {
            // Query errors are exposed through hook state.
        });
    }, [context, queryVersion, refetch, resourceId]);

    useEffect(() => {
        return () => {
            context.unregisterQueryResource(resourceId);
        };
    }, [context, resourceId]);

    return {
        ...state,
        isLoading: state.status === "loading",
        isError: state.status === "error",
        isSuccess: state.status === "success",
        refetch,
    };
}

export function useKlaspMutation<TProcedure extends KlaspMutationProcedure>(
    procedure: TProcedure,
): UseKlaspMutationResult<
    KlaspProcedureInput<TProcedure>,
    KlaspProcedureOutput<TProcedure>
>;
export function useKlaspMutation<TInput, TData>(
    path: string,
): UseKlaspMutationResult<TInput, TData>;
export function useKlaspMutation<TInput, TData>(
    procedureOrPath: string | KlaspMutationProcedure,
): UseKlaspMutationResult<TInput, TData> {
    const context = useRequiredKlaspContext();
    const path = context.getProcedurePath(procedureOrPath, "mutation");
    const mountedRef = useRef(false);
    const requestIdRef = useRef(0);
    const [state, setState] = useState<{
        data: TData | undefined;
        error: Error | null;
        status: KlaspMutationStatus;
    }>({
        data: undefined,
        error: null,
        status: "idle",
    });

    useEffect(() => {
        mountedRef.current = true;

        return () => {
            mountedRef.current = false;
        };
    }, []);

    const mutate = useCallback(
        async (input: TInput): Promise<TData> => {
            const requestId = requestIdRef.current + 1;
            requestIdRef.current = requestId;

            setState((previous) => ({
                data: previous.data,
                error: null,
                status: "loading",
            }));

            try {
                const response = (await context.client.mutation(
                    path,
                    input,
                )) as KlaspRpcResponse<TData>;
                const data = unwrapKlaspResponse(response);

                if (mountedRef.current && requestId === requestIdRef.current) {
                    setState({
                        data,
                        error: null,
                        status: "success",
                    });
                }

                return data;
            } catch (error) {
                const nextError = toError(error);

                if (mountedRef.current && requestId === requestIdRef.current) {
                    setState((previous) => ({
                        data: previous.data,
                        error: nextError,
                        status: "error",
                    }));
                }

                throw nextError;
            }
        },
        [context, path],
    );

    const reset = useCallback(() => {
        setState({
            data: undefined,
            error: null,
            status: "idle",
        });
    }, []);

    return {
        ...state,
        isLoading: state.status === "loading",
        isError: state.status === "error",
        isSuccess: state.status === "success",
        mutate,
        reset,
    };
}

function useRequiredKlaspContext(): KlaspReactContextValue {
    const context = useContext(KlaspReactContext);
    if (!context) {
        throw new Error("Klasp hooks must be used inside a KlaspProvider.");
    }

    return context;
}

function createProcedurePathMap(api: Record<string, unknown>) {
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

function isKlaspProcedure(
    value: object,
): value is KlaspQueryProcedure | KlaspMutationProcedure {
    return (
        "type" in value &&
        (value.type === "query" || value.type === "mutation") &&
        "handler" in value
    );
}

function parseInvalidationEvent(
    message: MessageEvent,
): { topic: string } | null {
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

function unwrapKlaspResponse<TData>(response: KlaspRpcResponse<TData>): TData {
    if (response.ok) {
        return response.data;
    }

    throw new KlaspError(
        response.error.code,
        response.error.message,
        response.error.details,
    );
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function stableSerialize(value: unknown): string {
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
