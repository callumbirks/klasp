export interface CreateKlaspClientOptions {
    endpoint: string;
    fetch?: typeof fetch;
}

export interface KlaspCallResponse<TData> {
    data: TData;
    live?: {
        topics: string[];
    };
}

export function createKlaspClient(options: CreateKlaspClientOptions) {
    const fetchImpl = options.fetch ?? fetch;

    return {
        async call<TInput, TOutput>(
            procedure: string,
            input: TInput,
        ): Promise<KlaspCallResponse<TOutput>> {
            const response = await fetchImpl(
                `${options.endpoint}/call/${procedure}`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(input),
                },
            );

            if (!response.ok) {
                throw new Error(`Klasp call failed: ${response.status}`);
            }

            return response.json() as Promise<KlaspCallResponse<TOutput>>;
        },

        connectEvents(onEvent: (event: MessageEvent) => void) {
            const source = new EventSource(`${options.endpoint}/events`);

            source.addEventListener("klasp.invalidate", onEvent);

            return () => {
                source.close();
            };
        },
    };
}
