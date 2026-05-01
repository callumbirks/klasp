import {
    KLASP_PROCEDURE_DESCRIPTOR,
    KlaspError,
    type KlaspProcedureDescriptor,
    type KlaspRpcRequest,
    type KlaspRpcResponse,
} from "@klasp/core";

export interface CreateKlaspClientOptions {
    endpoint: string;
    fetch?: typeof fetch;
}

export type KlaspLegacyQueryProcedure = {
    type: "query";
    handler: unknown;
};

export type KlaspLegacyMutationProcedure = {
    type: "mutation";
    handler: unknown;
};

export type KlaspQueryProcedure<TInput = unknown, TOutput = unknown> =
    | KlaspProcedureDescriptor<"query", TInput, TOutput>
    | KlaspLegacyQueryProcedure;

export type KlaspMutationProcedure<TInput = unknown, TOutput = unknown> =
    | KlaspProcedureDescriptor<"mutation", TInput, TOutput>
    | KlaspLegacyMutationProcedure;

export type KlaspProcedureInput<TProcedure> = TProcedure extends {
    readonly [KLASP_PROCEDURE_DESCRIPTOR]: true;
    readonly __input?: infer TInput;
}
    ? TInput
    : TProcedure extends {
            handler: (args: infer TArgs) => unknown;
        }
      ? TArgs extends { input: infer TInput }
          ? TInput
          : never
      : never;

export type KlaspProcedureOutput<TProcedure> = TProcedure extends {
    readonly [KLASP_PROCEDURE_DESCRIPTOR]: true;
    readonly __output?: infer TOutput;
}
    ? TOutput
    : TProcedure extends {
            handler: (args: infer _TArgs) => infer TResult;
        }
      ? Awaited<TResult>
      : never;

export interface KlaspQueryResource {
    id: string;
    topics: string[];
    refresh: () => Promise<unknown> | unknown;
}

export interface KlaspInvalidationMessage {
    topic: string;
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

        // Klasp server will always return a 200 status code, even if the request is invalid.
        // So this is a HTTP failure.
        if (!response.ok) {
            throw new Error(`Klasp call failed: ${response.status}`);
        }

        const data = (await response.json()) as KlaspRpcResponse<TOutput>;

        return data;
    };

    const connectEvents = (onEvent: (event: MessageEvent) => void) => {
        const source = new EventSource(`${options.endpoint}/events`);

        source.addEventListener("klasp.invalidate", onEvent);

        return () => {
            source.close();
        };
    };

    return {
        query: call.bind(null, "query"),
        mutation: call.bind(null, "mutation"),
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
    };
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

export function createKlaspInvalidationRegistry() {
    const resourcesById = new Map<string, KlaspQueryResource>();
    const resourcesByTopic = new Map<string, Set<string>>();

    const unregister = (id: string) => {
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
    };

    const register = (resource: KlaspQueryResource) => {
        unregister(resource.id);
        resourcesById.set(resource.id, resource);

        for (const topic of resource.topics) {
            const ids = resourcesByTopic.get(topic) ?? new Set<string>();
            ids.add(resource.id);
            resourcesByTopic.set(topic, ids);
        }
    };

    const invalidate = (topic: string) => {
        const resourceIds = resourcesByTopic.get(topic);
        if (!resourceIds) {
            return;
        }

        for (const resourceId of resourceIds) {
            const resource = resourcesById.get(resourceId);
            void resource?.refresh();
        }
    };

    return {
        register,
        unregister,
        invalidate,
    };
}

export function isKlaspProcedure(
    value: object,
): value is KlaspQueryProcedure | KlaspMutationProcedure {
    const isProcedureType =
        "type" in value &&
        (value.type === "query" || value.type === "mutation");

    return (
        isProcedureType &&
        ((KLASP_PROCEDURE_DESCRIPTOR in value &&
            value[KLASP_PROCEDURE_DESCRIPTOR] === true) ||
            "handler" in value)
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
