import {
    type CreateKlaspClientOptions,
    createKlaspClient,
    type KlaspClient,
    type KlaspMutationProcedure,
    type KlaspProcedureInput,
    type KlaspProcedureOutput,
    type KlaspQueryProcedure,
    type KlaspQueryResource,
    type KlaspQueryResourceState,
    toError,
} from "@klasp/client";
import {
    createContext,
    createElement,
    type ReactElement,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";

export type {
    KlaspClient,
    KlaspConnectionStatus,
    KlaspMutationProcedure,
    KlaspProcedureInput,
    KlaspProcedureOutput,
    KlaspQueryProcedure,
    KlaspQueryResource,
    KlaspQueryResourceState,
    KlaspQueryStatus,
} from "@klasp/client";

export type KlaspMutationStatus = "idle" | "loading" | "success" | "error";

export interface KlaspProviderProps<TApi extends Record<string, unknown>> {
    api: TApi;
    endpoint: string;
    fetch?: CreateKlaspClientOptions<TApi>["fetch"];
    children: ReactNode;
}

export interface UseKlaspQueryOptions {
    enabled?: boolean;
}

export interface UseKlaspQueryResult<TData>
    extends KlaspQueryResourceState<TData> {
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
    client: KlaspClient;
}

const KlaspReactContext = createContext<KlaspReactContextValue | null>(null);

export function KlaspProvider<TApi extends Record<string, unknown>>({
    api,
    endpoint,
    fetch,
    children,
}: KlaspProviderProps<TApi>): ReactElement {
    const client = useMemo(() => {
        if (fetch) {
            return createKlaspClient({ api, endpoint, fetch });
        }

        return createKlaspClient({ api, endpoint });
    }, [api, endpoint, fetch]);

    const value = useMemo<KlaspReactContextValue>(
        () => ({
            client,
        }),
        [client],
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
    const { client } = useRequiredKlaspContext();
    const enabled = options.enabled ?? true;
    const resourceKey = client.getResourceKey(procedureOrPath, input);
    const inputRef = useRef(input);
    const pendingDisposalsRef = useRef<
        Map<KlaspQueryResource<unknown, TData>, ReturnType<typeof setTimeout>>
    >(new Map());
    inputRef.current = input;
    const resource = useMemo(() => {
        // Recreate when the deterministic key changes, while reading the
        // latest input through a ref to avoid identity-only churn.
        void resourceKey;

        return createQueryResource<TData>(
            client,
            procedureOrPath,
            inputRef.current,
            {
                enabled,
            },
        );
    }, [client, enabled, procedureOrPath, resourceKey]);
    const [state, setState] = useState(resource.getSnapshot);

    useEffect(() => {
        const pendingDispose = pendingDisposalsRef.current.get(resource);

        if (pendingDispose) {
            clearTimeout(pendingDispose);
            pendingDisposalsRef.current.delete(resource);
        }

        setState(resource.getSnapshot());
        return resource.subscribe(setState);
    }, [resource]);

    useEffect(() => {
        if (!enabled) {
            return;
        }

        void resource.refetch().catch(() => {
            // Query errors are exposed through hook state.
        });
    }, [enabled, resource]);

    useEffect(() => {
        return () => {
            const timer = setTimeout(() => {
                if (!pendingDisposalsRef.current.has(resource)) {
                    return;
                }

                resource.dispose();
                pendingDisposalsRef.current.delete(resource);
            }, 0);

            pendingDisposalsRef.current.set(resource, timer);
        };
    }, [resource]);

    return {
        ...state,
        refetch: resource.refetch,
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
    const { client } = useRequiredKlaspContext();
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
                const data = await runMutation<TInput, TData>(
                    client,
                    procedureOrPath,
                    input,
                );

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
        [client, procedureOrPath],
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

function createQueryResource<TData>(
    client: KlaspClient,
    procedureOrPath: string | KlaspQueryProcedure,
    input: unknown,
    options: UseKlaspQueryOptions,
): KlaspQueryResource<unknown, TData> {
    if (typeof procedureOrPath === "string") {
        return client.createQueryResource<unknown, TData>(
            procedureOrPath,
            input,
            options,
        );
    }

    return client.createQueryResource(
        procedureOrPath,
        input,
        options,
    ) as KlaspQueryResource<unknown, TData>;
}

function runMutation<TInput, TData>(
    client: KlaspClient,
    procedureOrPath: string | KlaspMutationProcedure,
    input: TInput,
): Promise<TData> {
    if (typeof procedureOrPath === "string") {
        return client.mutation<TInput, TData>(procedureOrPath, input);
    }

    return client.mutation(procedureOrPath, input) as Promise<TData>;
}
