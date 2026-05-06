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
    failureMode: "local_fallback",
    onError(error, context) {
        console.error("Klasp Redis realtime error", context, error);
    },
});

const klasp = createKlasp({ realtime });
```

All application instances that should share invalidations must use the same
Redis URL and namespace. Use separate namespaces for separate applications,
deployments, or environments.

## Redis Failure Mode

By default, Redis command failures block mutations. This is the safer mode for
multi-instance deployments because a successful mutation without cross-instance
fanout can leave other clients showing stale data.

```ts
const realtime = redisRealtimeAdapter({
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
    failureMode: "local_fallback",
});
```

Set `failureMode` to `"allow_mutations"` if the application should continue
when Redis is unreachable. In this mode, failed publishes are delivered only to
clients connected to the current server instance through local fallback
handlers. Clients connected to other instances will not receive those
invalidations.

```ts
const realtime = redisRealtimeAdapter({
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
    failureMode: "allow_mutations",
});
```

Redis Pub/Sub does not retain messages while an instance is disconnected. Klasp
therefore cannot recover invalidations missed during Redis downtime with this
adapter alone. Durable recovery will need a later mechanism such as topic
version counters or Redis Streams, plus client reconnect checks.

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
