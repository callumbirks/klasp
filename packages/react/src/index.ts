import {
    type CreateKlaspClientOptions,
    createKlaspClient,
    createKlaspInvalidationRegistry,
    createKlaspProcedurePathMap,
    getKlaspProcedurePath,
    type KlaspMutationProcedure,
    type KlaspProcedureInput,
    type KlaspProcedureOutput,
    type KlaspQueryProcedure,
    type KlaspQueryResource,
    stableSerialize,
    toError,
    unwrapKlaspResponse,
} from "@klasp/client";
import type { KlaspRpcResponse } from "@klasp/core";
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

export type {
    KlaspMutationProcedure,
    KlaspProcedureInput,
    KlaspProcedureOutput,
    KlaspQueryProcedure,
} from "@klasp/client";

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

interface KlaspReactContextValue {
    client: ReturnType<typeof createKlaspClient>;
    getProcedurePath: (
        procedure: string | KlaspQueryProcedure | KlaspMutationProcedure,
        type: "query" | "mutation",
    ) => string;
    registerQueryResource: (resource: KlaspQueryResource) => void;
    unregisterQueryResource: (id: string) => void;
}

const KlaspReactContext = createContext<KlaspReactContextValue | null>(null);

export function KlaspProvider<TApi extends Record<string, unknown>>({
    api,
    endpoint,
    fetch,
    children,
}: KlaspProviderProps<TApi>): ReactElement {
    const procedurePaths = useMemo(
        () => createKlaspProcedurePathMap(api),
        [api],
    );
    const invalidationRegistry = useMemo(
        () => createKlaspInvalidationRegistry(),
        [],
    );

    const client = useMemo(() => {
        if (fetch) {
            return createKlaspClient({ endpoint, fetch });
        }

        return createKlaspClient({ endpoint });
    }, [endpoint, fetch]);

    const unregisterQueryResource = invalidationRegistry.unregister;
    const registerQueryResource = invalidationRegistry.register;

    const getProcedurePath = useCallback(
        (
            procedure: string | KlaspQueryProcedure | KlaspMutationProcedure,
            type: "query" | "mutation",
        ): string => {
            return getKlaspProcedurePath(procedure, type, procedurePaths);
        },
        [procedurePaths],
    );

    useEffect(() => {
        return client.connectInvalidations((event) => {
            invalidationRegistry.invalidate(event.topic);
        });
    }, [client, invalidationRegistry]);

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
