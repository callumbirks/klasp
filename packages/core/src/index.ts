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

export type KlaspObserve = (event: KlaspObservabilityEvent) => void;

export type KlaspObservabilityEvent =
    | KlaspServerObservabilityEvent
    | KlaspClientObservabilityEvent
    | KlaspRedisObservabilityEvent;

export type KlaspServerObservabilityEvent =
    | KlaspServerRpcStartEvent
    | KlaspServerRpcSuccessEvent
    | KlaspServerRpcErrorEvent
    | KlaspServerInvalidationStartEvent
    | KlaspServerInvalidationSuccessEvent
    | KlaspServerInvalidationErrorEvent
    | KlaspServerSseOpenEvent
    | KlaspServerSseCloseEvent
    | KlaspServerSseRejectEvent
    | KlaspServerTopicRegisterEvent;

export interface KlaspServerRpcStartEvent {
    type: "server.rpc.start";
    timestamp: number;
    path: string;
    procedureType: KlaspProcedureType;
    clientId?: string;
}

export interface KlaspServerRpcSuccessEvent {
    type: "server.rpc.success";
    timestamp: number;
    path: string;
    procedureType: KlaspProcedureType;
    clientId?: string;
    durationMs: number;
    liveTopicCount: number;
}

export interface KlaspServerRpcErrorEvent {
    type: "server.rpc.error";
    timestamp: number;
    path?: string;
    procedureType?: KlaspProcedureType;
    clientId?: string;
    durationMs?: number;
    errorCode: KlaspErrorCode;
    message: string;
}

export interface KlaspServerInvalidationStartEvent {
    type: "server.invalidation.start";
    timestamp: number;
    topic: string;
}

export interface KlaspServerInvalidationSuccessEvent {
    type: "server.invalidation.success";
    timestamp: number;
    topic: string;
    durationMs: number;
}

export interface KlaspServerInvalidationErrorEvent {
    type: "server.invalidation.error";
    timestamp: number;
    topic: string;
    durationMs: number;
    errorCode: KlaspErrorCode;
    message: string;
}

export interface KlaspServerSseOpenEvent {
    type: "server.sse.open";
    timestamp: number;
    clientId: string;
}

export interface KlaspServerSseCloseEvent {
    type: "server.sse.close";
    timestamp: number;
    clientId: string;
}

export interface KlaspServerSseRejectEvent {
    type: "server.sse.reject";
    timestamp: number;
    errorCode: KlaspErrorCode;
    message: string;
}

export interface KlaspServerTopicRegisterEvent {
    type: "server.topic.register";
    timestamp: number;
    clientId: string;
    topics: string[];
    topicCount: number;
}

export type KlaspClientObservabilityEvent =
    | KlaspClientRpcStartEvent
    | KlaspClientRpcSuccessEvent
    | KlaspClientRpcErrorEvent
    | KlaspClientConnectionStatusEvent
    | KlaspClientInvalidationReceivedEvent
    | KlaspClientResourceRegisterEvent
    | KlaspClientResourceUnregisterEvent
    | KlaspClientResourceRefetchEvent;

export interface KlaspClientRpcStartEvent {
    type: "client.rpc.start";
    timestamp: number;
    path: string;
    procedureType: KlaspProcedureType;
    clientId: string;
}

export interface KlaspClientRpcSuccessEvent {
    type: "client.rpc.success";
    timestamp: number;
    path: string;
    procedureType: KlaspProcedureType;
    clientId: string;
    durationMs: number;
    liveTopicCount: number;
}

export interface KlaspClientRpcErrorEvent {
    type: "client.rpc.error";
    timestamp: number;
    path: string;
    procedureType: KlaspProcedureType;
    clientId: string;
    durationMs: number;
    errorCode?: KlaspErrorCode;
    message: string;
}

export interface KlaspClientConnectionStatusEvent {
    type: "client.connection.status";
    timestamp: number;
    clientId: string;
    status: "idle" | "connecting" | "connected" | "error" | "closed";
}

export interface KlaspClientInvalidationReceivedEvent {
    type: "client.invalidation.received";
    timestamp: number;
    clientId: string;
    topic: string;
    matchedResourceCount: number;
}

export interface KlaspClientResourceRegisterEvent {
    type: "client.resource.register";
    timestamp: number;
    clientId: string;
    resourceId: string;
    path: string;
    topics: string[];
    topicCount: number;
}

export interface KlaspClientResourceUnregisterEvent {
    type: "client.resource.unregister";
    timestamp: number;
    clientId: string;
    resourceId: string;
    topics: string[];
    topicCount: number;
}

export interface KlaspClientResourceRefetchEvent {
    type: "client.resource.refetch";
    timestamp: number;
    clientId: string;
    resourceId: string;
    path: string;
    reason: "manual" | "invalidation" | "reconnect";
    status: "start" | "success" | "error";
    durationMs?: number;
    errorCode?: KlaspErrorCode;
    message?: string;
}

export type KlaspRedisObservabilityEvent =
    | KlaspRedisConnectSuccessEvent
    | KlaspRedisConnectErrorEvent
    | KlaspRedisPublishSuccessEvent
    | KlaspRedisPublishErrorEvent
    | KlaspRedisSubscribeSuccessEvent
    | KlaspRedisSubscribeErrorEvent
    | KlaspRedisUnsubscribeEvent
    | KlaspRedisCloseEvent
    | KlaspRedisClientErrorEvent
    | KlaspRedisFallbackEvent
    | KlaspRedisMessageErrorEvent
    | KlaspRedisHandlerErrorEvent;

export type KlaspRedisRole = "publisher" | "subscriber";

export interface KlaspRedisConnectSuccessEvent {
    type: "redis.connect.success";
    timestamp: number;
    role: KlaspRedisRole;
    channel: string;
    durationMs: number;
}

export interface KlaspRedisConnectErrorEvent {
    type: "redis.connect.error";
    timestamp: number;
    role: KlaspRedisRole;
    channel: string;
    durationMs: number;
    message: string;
}

export interface KlaspRedisPublishSuccessEvent {
    type: "redis.publish.success";
    timestamp: number;
    channel: string;
    topic: string;
    durationMs: number;
}

export interface KlaspRedisPublishErrorEvent {
    type: "redis.publish.error";
    timestamp: number;
    channel: string;
    topic: string;
    durationMs: number;
    message: string;
}

export interface KlaspRedisSubscribeSuccessEvent {
    type: "redis.subscribe.success";
    timestamp: number;
    channel: string;
    durationMs: number;
}

export interface KlaspRedisSubscribeErrorEvent {
    type: "redis.subscribe.error";
    timestamp: number;
    channel: string;
    durationMs: number;
    message: string;
}

export interface KlaspRedisUnsubscribeEvent {
    type: "redis.unsubscribe";
    timestamp: number;
    channel: string;
}

export interface KlaspRedisCloseEvent {
    type: "redis.close";
    timestamp: number;
    channel: string;
}

export interface KlaspRedisClientErrorEvent {
    type: "redis.client.error";
    timestamp: number;
    role: KlaspRedisRole;
    channel: string;
    message: string;
}

export interface KlaspRedisFallbackEvent {
    type: "redis.fallback";
    timestamp: number;
    operation: "publish" | "subscribe";
    channel: string;
    message: string;
}

export interface KlaspRedisMessageErrorEvent {
    type: "redis.message.error";
    timestamp: number;
    channel: string;
    message: string;
}

export interface KlaspRedisHandlerErrorEvent {
    type: "redis.handler.error";
    timestamp: number;
    channel: string;
    message: string;
}

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
