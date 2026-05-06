export class KlaspError extends Error {
    constructor(
        public readonly code: KlaspErrorCode,
        message: string,
        public readonly details?: unknown,
    ) {
        super(message);
        this.name = "KlaspError";
    }
}

export type KlaspErrorCode =
    | "BAD_REQUEST"
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "CONFLICT"
    | "RATE_LIMITED"
    | "VALIDATION_ERROR"
    | "INTERNAL_SERVER_ERROR";

export interface KlaspRealtimeAdapter {
    publishInvalidation(topic: string): Promise<void>;
    subscribeInvalidations(
        handler: (event: KlaspInvalidationEvent) => Promise<void> | void,
    ): Promise<() => Promise<void>>;
    close?(): Promise<void>;
}

export interface KlaspInvalidationEvent {
    type: "invalidate";
    topic: string;
    timestamp: number;
}

export interface KlaspLiveConfig {
    topics: string[];
}

export const KLASP_PROCEDURE_DESCRIPTOR = Symbol.for(
    "klasp.procedureDescriptor",
);

export type KlaspProcedureType = "query" | "mutation";

export interface KlaspProcedureDescriptor<
    TType extends KlaspProcedureType,
    TInput,
    TOutput,
> {
    readonly [KLASP_PROCEDURE_DESCRIPTOR]: true;
    readonly type: TType;
    readonly __input?: TInput;
    readonly __output?: TOutput;
}

export type KlaspAnyProcedureDescriptor = KlaspProcedureDescriptor<
    KlaspProcedureType,
    unknown,
    unknown
>;

export type KlaspRouterContract = {
    readonly [key: string]: KlaspAnyProcedureDescriptor | KlaspRouterContract;
};

export interface KlaspContractBuilder {
    query<TInput, TOutput>(): KlaspProcedureDescriptor<
        "query",
        TInput,
        TOutput
    >;
    mutation<TInput, TOutput>(): KlaspProcedureDescriptor<
        "mutation",
        TInput,
        TOutput
    >;
    router<TProcedures extends KlaspRouterContract>(
        procedures: TProcedures,
    ): TProcedures;
}

export function createKlaspContract(): KlaspContractBuilder {
    return {
        query<TInput, TOutput>() {
            return createKlaspProcedureDescriptor<"query", TInput, TOutput>(
                "query",
            );
        },

        mutation<TInput, TOutput>() {
            return createKlaspProcedureDescriptor<"mutation", TInput, TOutput>(
                "mutation",
            );
        },

        router<TProcedures extends KlaspRouterContract>(
            procedures: TProcedures,
        ): TProcedures {
            return procedures;
        },
    };
}

export function createKlaspProcedureDescriptor<
    TType extends KlaspProcedureType,
    TInput,
    TOutput,
>(type: TType): KlaspProcedureDescriptor<TType, TInput, TOutput> {
    return {
        [KLASP_PROCEDURE_DESCRIPTOR]: true,
        type,
    } as KlaspProcedureDescriptor<TType, TInput, TOutput>;
}

export interface KlaspRpcRequest<TInput> {
    version: number;
    type: "query" | "mutation";
    path: string;
    input: TInput;
    clientId?: string;
}

export type KlaspRpcResponse<TOutput> =
    | {
          ok: true;
          data: TOutput;
          live: KlaspLiveConfig | undefined;
          error: undefined;
      }
    | {
          ok: false;
          error: {
              code: KlaspErrorCode;
              message: string;
              details?: unknown;
          };
          data: undefined;
          live: undefined;
      };
