import type {
    KlaspErrorCode,
    KlaspRpcRequest,
    KlaspRpcResponse,
} from "@klasp/core";

export interface CreateKlaspClientOptions {
    endpoint: string;
    fetch?: typeof fetch;
}

export function getKlaspErrorCode(status: number): KlaspErrorCode {
    switch (status) {
        case 404:
            return "NOT_FOUND";
        case 400:
            return "BAD_REQUEST";
        case 401:
            return "UNAUTHORIZED";
        case 403:
            return "FORBIDDEN";
        case 409:
            return "CONFLICT";
        case 429:
            return "RATE_LIMITED";
        case 500:
            return "INTERNAL_SERVER_ERROR";
        default:
            return "INTERNAL_SERVER_ERROR";
    }
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
            return {
                ok: false,
                error: {
                    code: getKlaspErrorCode(response.status),
                    message: `Klasp call failed: ${response.status}`,
                },
                data: undefined,
                live: undefined,
            };
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
