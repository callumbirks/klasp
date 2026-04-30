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
}

export interface KlaspInvalidationEvent {
    type: "invalidate";
    topic: string;
    timestamp: number;
}

export interface KlaspLiveConfig {
    topics: string[];
}

export interface KlaspRpcRequest<TInput> {
    version: number;
    type: "query" | "mutation";
    path: string;
    input: TInput;
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
