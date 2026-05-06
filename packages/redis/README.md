# @klasp/redis

Redis realtime adapter for Klasp invalidation fanout across multiple server
instances.

## Local Redis

For local development, run Redis with Docker:

```sh
docker run --rm -p 6379:6379 redis:7
```

Or use a locally installed Redis service and point the adapter at that URL.

## Usage

```ts
import { redisRealtimeAdapter } from "@klasp/redis";
import { createKlasp } from "@klasp/server";

const realtime = redisRealtimeAdapter({
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
    namespace: "my-app-dev",
    onError(error, context) {
        console.error("Klasp Redis realtime error", context, error);
    },
});

const klasp = createKlasp({ realtime });
```

All application instances that should share invalidations must use the same
Redis URL and namespace. Use separate namespaces for separate applications,
deployments, or environments.

## Shutdown

Close the adapter during application shutdown so Redis subscriptions and client
connections are cleaned up:

```ts
await realtime.close?.();
```

Klasp does not close application-owned adapters automatically.

## Topic Versions

This adapter currently publishes invalidation events with `type`, `topic`, and
`timestamp`. Redis topic version counters are intentionally deferred until Klasp
adds missed-event detection and reconnect recovery semantics.
