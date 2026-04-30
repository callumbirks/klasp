import type { KlaspLiveConfig, KlaspRealtimeAdapter } from "@klasp/core";

export interface KlaspContext {
    [key: string]: unknown;
}

export interface CreateKlaspOptions<TContext extends KlaspContext> {
    auth?: (input: { request: Request }) => Promise<TContext> | TContext;
    realtime?: KlaspRealtimeAdapter;
}

export interface KlaspQueryDefinition<TInput, TOutput, TContext> {
    type: "query";
    parseInput?: (input: unknown) => TInput;
    handler: (input: {
        input: TInput;
        ctx: TContext;
        klasp: KlaspRuntime;
    }) => Promise<TOutput> | TOutput;
    live?: (input: { input: TInput; ctx: TContext }) => KlaspLiveConfig;
}

export interface KlaspMutationDefinition<TInput, TOutput, TContext> {
    type: "mutation";
    parseInput?: (input: unknown) => TInput;
    handler: (input: {
        input: TInput;
        ctx: TContext;
        klasp: KlaspRuntime;
    }) => Promise<TOutput> | TOutput;
}

export interface KlaspRuntime {
    invalidate(topic: string): Promise<void>;
}

export interface Klasp<TContext extends KlaspContext = KlaspContext> {
    query<TInput, TOutput>(
        definition: KlaspQueryDefinition<TInput, TOutput, TContext>,
    ): KlaspQueryDefinition<TInput, TOutput, TContext>;
    mutation<TInput, TOutput>(
        definition: KlaspMutationDefinition<TInput, TOutput, TContext>,
    ): KlaspMutationDefinition<TInput, TOutput, TContext>;
    router<TProcedures extends Record<string, unknown>>(
        procedures: TProcedures,
    ): TProcedures;
    createContext(request: Request): Promise<TContext>;
    runtime: KlaspRuntime;
    realtime: KlaspRealtimeAdapter | undefined;
}

export function createKlasp<TContext extends KlaspContext = KlaspContext>(
    options: CreateKlaspOptions<TContext>,
): Klasp<TContext> {
    const runtime: KlaspRuntime = {
        async invalidate(topic: string) {
            await options.realtime?.publishInvalidation(topic);
        },
    };

    return {
        query<TInput, TOutput>(
            definition: Omit<
                KlaspQueryDefinition<TInput, TOutput, TContext>,
                "type"
            >,
        ): KlaspQueryDefinition<TInput, TOutput, TContext> {
            return {
                type: "query",
                ...definition,
            };
        },

        mutation<TInput, TOutput>(
            definition: Omit<
                KlaspMutationDefinition<TInput, TOutput, TContext>,
                "type"
            >,
        ): KlaspMutationDefinition<TInput, TOutput, TContext> {
            return {
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
    };
}
