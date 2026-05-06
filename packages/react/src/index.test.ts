// @vitest-environment happy-dom

import { createKlaspContract, KlaspError } from "@klasp/core";
import {
    act,
    createElement,
    type JSX,
    type ReactElement,
    useEffect,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
    KlaspProvider,
    type UseKlaspMutationResult,
    type UseKlaspQueryResult,
    useKlaspMutation,
    useKlaspQuery,
} from "./index.js";

(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type MessagesInput = { roomId: string };
type SendInput = { roomId: string; text: string };
type RpcBody = {
    type: string;
    path: string;
    input: unknown;
    clientId?: string;
};
type QueryRender = Pick<
    UseKlaspQueryResult<string[]>,
    "data" | "error" | "isLoading" | "refetch" | "status"
>;
type MutationRender = UseKlaspMutationResult<SendInput, string>;

class FakeEventSource {
    static instances: FakeEventSource[] = [];
    static urls: string[] = [];

    private readonly listeners = new Map<
        string,
        Set<(event: MessageEvent) => void>
    >();

    constructor(public readonly url: string) {
        FakeEventSource.urls.push(url);
        FakeEventSource.instances.push(this);
    }

    addEventListener(event: string, listener: (event: MessageEvent) => void) {
        const listeners = this.listeners.get(event) ?? new Set();
        listeners.add(listener);
        this.listeners.set(event, listeners);
    }

    removeEventListener(
        event: string,
        listener: (event: MessageEvent) => void,
    ) {
        this.listeners.get(event)?.delete(listener);
    }

    close() {}

    emit(event: string, data: unknown) {
        for (const listener of this.listeners.get(event) ?? []) {
            listener({ data: JSON.stringify(data) } as MessageEvent);
        }
    }
}

const contract = createKlaspContract();
const api = contract.router({
    rooms: {
        messages: contract.query<MessagesInput, string[]>(),
        sendMessage: contract.mutation<SendInput, string>(),
    },
});
const TestKlaspProvider = KlaspProvider as unknown as (props: {
    api: typeof api;
    endpoint: string;
    fetch: typeof fetch;
}) => ReactElement;

afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
    FakeEventSource.urls = [];
    document.body.innerHTML = "";
});

describe("KlaspProvider and hooks", () => {
    test("useKlaspQuery starts loading, fetches, and exposes success data", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const requests: RpcBody[] = [];
        const fetch = createFetch(
            [
                {
                    ok: true,
                    data: ["hello"],
                    live: { topics: ["room:a"] },
                    error: undefined,
                },
            ],
            requests,
        );
        const renders: QueryRender[] = [];

        await mount(
            createElement(QueryProbe, {
                fetch,
                onRender: (render) => renders.push(render),
                roomId: "a",
            }),
        );

        await waitFor(() => last(renders)?.status === "success");

        expect(renders[0]).toMatchObject({
            status: "loading",
            isLoading: true,
        });
        expect(last(renders)).toMatchObject({
            data: ["hello"],
            status: "success",
        });
        expect(requests).toEqual([
            expect.objectContaining({
                type: "query",
                path: "rooms.messages",
                input: { roomId: "a" },
            }),
        ]);
    });

    test("useKlaspQuery refreshes only when its live topic is invalidated", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const requests: RpcBody[] = [];
        const fetch = createFetch(
            [
                {
                    ok: true,
                    data: ["a1"],
                    live: { topics: ["room:a"] },
                    error: undefined,
                },
                {
                    ok: true,
                    data: ["a2"],
                    live: { topics: ["room:a"] },
                    error: undefined,
                },
            ],
            requests,
        );
        const renders: QueryRender[] = [];

        await mount(
            createElement(QueryProbe, {
                fetch,
                onRender: (render) => renders.push(render),
                roomId: "a",
            }),
        );

        await waitFor(() => last(renders)?.data?.[0] === "a1");
        act(() => {
            FakeEventSource.instances[0]?.emit("klasp.invalidate", {
                topic: "room:b",
            });
        });
        await flushTasks();

        expect(requests).toHaveLength(1);

        act(() => {
            FakeEventSource.instances[0]?.emit("klasp.invalidate", {
                topic: "room:a",
            });
        });
        await waitFor(() => last(renders)?.data?.[0] === "a2");

        expect(requests).toHaveLength(2);
    });

    test("useKlaspQuery can stay idle until manual refetch", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const requests: RpcBody[] = [];
        const fetch = createFetch(
            [
                {
                    ok: true,
                    data: ["manual"],
                    live: undefined,
                    error: undefined,
                },
            ],
            requests,
        );
        const renders: QueryRender[] = [];

        await mount(
            createElement(QueryProbe, {
                enabled: false,
                fetch,
                onRender: (render) => renders.push(render),
                roomId: "a",
            }),
        );
        await flushTasks();

        expect(last(renders)).toMatchObject({ status: "idle" });
        expect(requests).toHaveLength(0);

        await act(async () => {
            await last(renders)?.refetch();
        });

        expect(last(renders)).toMatchObject({
            data: ["manual"],
            status: "success",
        });
        expect(requests).toHaveLength(1);
    });

    test("useKlaspQuery creates a new resource when input changes", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const requests: RpcBody[] = [];
        const fetch = createFetch(
            [
                {
                    ok: true,
                    data: ["a"],
                    live: { topics: ["room:a"] },
                    error: undefined,
                },
                {
                    ok: true,
                    data: ["b"],
                    live: { topics: ["room:b"] },
                    error: undefined,
                },
            ],
            requests,
        );
        const renders: QueryRender[] = [];
        const mounted = await mount(
            createElement(QueryProbe, {
                fetch,
                onRender: (render) => renders.push(render),
                roomId: "a",
            }),
        );

        await waitFor(() => last(renders)?.data?.[0] === "a");
        await mounted.render(
            createElement(QueryProbe, {
                fetch,
                onRender: (render) => renders.push(render),
                roomId: "b",
            }),
        );
        await waitFor(() => last(renders)?.data?.[0] === "b");

        expect(requests.map((request) => request.input)).toEqual([
            { roomId: "a" },
            { roomId: "b" },
        ]);
    });

    test("unmount cleanup disposes live query resources", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const requests: RpcBody[] = [];
        const fetch = createFetch(
            [
                {
                    ok: true,
                    data: ["a1"],
                    live: { topics: ["room:a"] },
                    error: undefined,
                },
            ],
            requests,
        );
        const renders: QueryRender[] = [];
        const mounted = await mount(
            createElement(QueryProbe, {
                fetch,
                onRender: (render) => renders.push(render),
                roomId: "a",
            }),
        );

        await waitFor(() => last(renders)?.data?.[0] === "a1");
        await mounted.unmount();
        await flushTasks();
        act(() => {
            FakeEventSource.instances[0]?.emit("klasp.invalidate", {
                topic: "room:a",
            });
        });
        await flushTasks();

        expect(requests).toHaveLength(1);
    });

    test("useKlaspMutation moves through loading to success and can reset", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const response = createDeferred<unknown>();
        const fetch = createFetch([response.promise]);
        const renders: MutationRender[] = [];

        await mount(
            createElement(MutationProbe, {
                fetch,
                onRender: (render) => renders.push(render),
            }),
        );

        let mutationPromise: Promise<string> | undefined;
        await act(async () => {
            mutationPromise = last(renders)?.mutate({
                roomId: "a",
                text: "hi",
            });
        });

        expect(last(renders)).toMatchObject({
            status: "loading",
            isLoading: true,
        });

        response.resolve({
            ok: true,
            data: "sent",
            live: undefined,
            error: undefined,
        });
        await act(async () => {
            await mutationPromise;
        });

        expect(last(renders)).toMatchObject({
            data: "sent",
            status: "success",
        });

        act(() => {
            last(renders)?.reset();
        });

        expect(last(renders)).toMatchObject({
            data: undefined,
            error: null,
            status: "idle",
        });
    });

    test("useKlaspMutation exposes failed RPC responses as KlaspError state", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const fetch = createFetch([
            {
                ok: false,
                data: undefined,
                live: undefined,
                error: {
                    code: "FORBIDDEN",
                    message: "No access.",
                    details: { roomId: "a" },
                },
            },
        ]);
        const renders: MutationRender[] = [];

        await mount(
            createElement(MutationProbe, {
                fetch,
                onRender: (render) => renders.push(render),
            }),
        );

        await act(async () => {
            await last(renders)
                ?.mutate({
                    roomId: "a",
                    text: "hi",
                })
                .catch(() => {});
        });

        expect(last(renders)).toMatchObject({
            status: "error",
            isError: true,
            error: expect.any(KlaspError),
        });
        expect(last(renders)?.error).toMatchObject({
            code: "FORBIDDEN",
            message: "No access.",
            details: { roomId: "a" },
        });
    });
});

interface QueryProbeProps {
    enabled?: boolean | undefined;
    fetch: typeof fetch;
    onRender(render: QueryRender): void;
    roomId: string;
}

function QueryProbe({
    enabled,
    fetch,
    onRender,
    roomId,
}: QueryProbeProps): ReactElement {
    return createElement(
        TestKlaspProvider,
        { api, endpoint: "http://localhost/klasp", fetch },
        createElement(QueryStateProbe, {
            enabled,
            onRender,
            roomId,
        }),
    );
}

function QueryStateProbe({
    enabled,
    onRender,
    roomId,
}: Omit<QueryProbeProps, "fetch">): null {
    const query = useKlaspQuery(
        api.rooms.messages,
        { roomId },
        enabled === undefined ? undefined : { enabled },
    );

    useEffect(() => {
        onRender(query);
    });

    return null;
}

interface MutationProbeProps {
    fetch: typeof fetch;
    onRender(render: MutationRender): void;
}

function MutationProbe({ fetch, onRender }: MutationProbeProps): ReactElement {
    return createElement(
        TestKlaspProvider,
        { api, endpoint: "http://localhost/klasp", fetch },
        createElement(MutationStateProbe, {
            onRender,
        }),
    );
}

function MutationStateProbe({
    onRender,
}: Pick<MutationProbeProps, "onRender">): null {
    const mutation = useKlaspMutation(api.rooms.sendMessage);

    useEffect(() => {
        onRender(mutation);
    });

    return null;
}

function createFetch(
    responses: Array<unknown | Promise<unknown>>,
    requests: RpcBody[] = [],
): typeof fetch {
    return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as RpcBody);
        const response = await responses.shift();

        if (!response) {
            throw new Error("No fake response queued.");
        }

        return new Response(JSON.stringify(response));
    }) as unknown as typeof fetch;
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });

    return { promise, resolve };
}

async function mount(element: ReactElement): Promise<{
    render(nextElement: ReactElement): Promise<void>;
    unmount(): Promise<void>;
}> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await render(root, element);

    return {
        render(nextElement) {
            return render(root, nextElement);
        },
        async unmount() {
            await act(async () => {
                root.unmount();
            });
        },
    };
}

async function render(root: Root, element: ReactElement): Promise<void> {
    await act(async () => {
        root.render(element as JSX.Element);
    });
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const startedAt = Date.now();

    while (!predicate()) {
        if (Date.now() - startedAt > 500) {
            throw new Error("Timed out waiting for condition.");
        }

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 1));
        });
    }
}

async function flushTasks(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

function last<T>(values: T[]): T | undefined {
    return values.at(-1);
}
