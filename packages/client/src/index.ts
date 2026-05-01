import type { KlaspRpcRequest, KlaspRpcResponse } from "@klasp/core";

export interface CreateKlaspClientOptions {
    endpoint: string;
    fetch?: typeof fetch;
}

export function createKlaspClient(options: CreateKlaspClientOptions) {
    const fetchImpl = options.fetch ?? fetch;

    const call = async <TInput, TOutput>(
        type: "query" | "mutation",
        path: string,
        input: TInput,
    ): Promise<KlaspRpcResponse<TOutput>> => {
        const request: KlaspRpcRequest<TInput> = {
            version: 1,
            type,
            path,
            input,
        };
        const response = await fetchImpl(`${options.endpoint}/rpc`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(request),
        });

        if (!response.ok) {
            throw new Error(`Klasp call failed: ${response.status}`);
        }

        const data = (await response.json()) as KlaspRpcResponse<TOutput>;

        return data;
    };

    return {
        query: call.bind(null, "query"),
        mutation: call.bind(null, "mutation"),
        connectEvents(onEvent: (event: MessageEvent) => void) {
            const source = new EventSource(`${options.endpoint}/events`);

            source.addEventListener("klasp.invalidate", onEvent);

            return () => {
                source.close();
            };
        },
    };
}
