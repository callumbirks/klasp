# Klasp Design Document

## 1. Summary

Klasp is a TypeScript-first realtime API layer for existing backend applications.

It lets developers define type-safe backend queries and mutations, call them from the frontend, and keep frontend data fresh through explicit realtime invalidation powered by Redis.

The initial product wedge is:

> **tRPC-style APIs with realtime invalidation built in.**

Klasp is not a database, ORM, backend platform, or Convex clone. It is a coordination layer for teams that want Convex-like realtime ergonomics while keeping their own backend, database, deployment model, and business logic.

---

## 2. Problem

Many modern applications need realtime behaviour: chat, notifications, dashboards, job progress, support inboxes, multiplayer-lite state, presence, and operational panels.

Today, developers usually assemble this from separate pieces:

- HTTP endpoints
- client fetch wrappers
- cache keys
- manual invalidation
- WebSocket or SSE plumbing
- reconnect handling
- subscription authorization
- Redis Pub/Sub or another fanout layer
- debugging tools

Each part is manageable. Together, they create repetitive and fragile infrastructure.

Existing tools solve adjacent problems:

| Tool / Pattern    | Strength                           | Limitation                                        |
| ----------------- | ---------------------------------- | ------------------------------------------------- |
| tRPC              | Type-safe backend procedures       | Realtime is not the core primitive                |
| TanStack Query    | Excellent frontend cache lifecycle | Needs backend endpoints and realtime invalidation |
| Convex            | Excellent realtime DX              | Requires adopting Convex backend/database/runtime |
| Firebase          | Fast realtime app development      | Opinionated platform and data model               |
| Supabase Realtime | Strong Postgres-first realtime     | Tied to Postgres/platform model                   |
| Raw Redis         | Powerful realtime primitives       | Too low-level for application DX                  |

Klasp fills the gap for developers who want realtime application ergonomics without adopting a new database or backend runtime.

---

## 3. Goals

Klasp should make it easy to:

1. Define backend queries and mutations in TypeScript.
2. Call them type-safely from frontend code.
3. Attach queries to explicit realtime topics.
4. Invalidate subscribed frontend queries when backend state changes.
5. Avoid hand-written SSE/WebSocket plumbing in application code.
6. Work with existing databases, ORMs, auth systems, and backend frameworks.
7. Provide a client-agnostic core SDK with first-class integrations for pure React, TanStack Query, and Svelte.
8. Support horizontally scaled backend instances through Redis.
9. Start as a self-hosted library.
10. Leave room for a hosted realtime gateway later.

The developer experience should feel close to this:

```tsx
const { data: messages } = useKlaspQuery(api.rooms.messages, { roomId });

const sendMessage = useKlaspMutation(api.rooms.sendMessage);
```

And on the server:

```ts
await klasp.invalidate(`room:${roomId}:messages`);
```

---

## 4. Non-Goals

Klasp should not initially be:

- a database
- an ORM
- an auth platform
- a deployment platform
- a file storage system
- a background compute runtime
- a generic cron or job platform
- a full Convex/Firebase replacement
- an automatic database dependency tracker

Users bring their own backend and database. Klasp coordinates realtime invalidation around them.

Automatic dependency tracking is specifically out of scope for the initial product. The MVP should use explicit live topics because they are simpler, safer, and easier to debug.

---

## 5. Positioning

Primary positioning:

> **Realtime APIs for your existing backend.**

Expanded positioning:

> Klasp gives TypeScript apps Convex-like realtime developer experience without requiring teams to adopt a new database, runtime, or platform.

Klasp is best understood as:

- a type-safe backend procedure layer
- a realtime invalidation layer
- a client SDK
- framework/client integrations for React, TanStack Query, Svelte, and later others
- a Redis-backed coordination system

It is not “just Pub/Sub”. The product value comes from connecting backend procedures, frontend cache invalidation, auth, and realtime delivery into one coherent programming model.

---

## 6. Target Users

Klasp is for TypeScript developers building applications such as:

- SaaS dashboards
- AI chat apps
- realtime admin panels
- support inboxes
- notification systems
- collaboration tools
- live monitoring tools
- game server panels
- internal tools

The ideal early adopter:

- uses React, Svelte, TanStack Query, or similar frontend tooling
- has an existing backend
- has or can add Redis
- wants realtime updates
- does not want to move fully to Convex/Firebase
- is tired of wiring SSE/WebSockets manually

Bad initial fits:

- high-frequency multiplayer games
- CRDT-heavy collaborative editors
- offline-first mobile sync apps
- teams wanting zero-code backend generation
- teams unwilling to operate or use Redis

---

## 7. Core Model

Klasp exposes backend procedures:

- `query`
- `mutation`

Queries may declare live topics.

Mutations may invalidate those topics.

Clients subscribe to topics indirectly by running authorized queries. When a topic is invalidated, Klasp tells the client runtime which active query resources to refresh. Individual integrations decide whether that means updating React state, invalidating TanStack Query cache entries, refreshing Svelte stores, or using another client-specific mechanism.

### Server Example

```ts
export const api = klasp.router({
  rooms: klasp.router({
    messages: klasp.query({
      input: z.object({ roomId: z.string() }),

      handler: async ({ input, ctx }) => {
        await assertRoomAccess(ctx.user.id, input.roomId);

        return db.query.messages.findMany({
          where: eq(messages.roomId, input.roomId),
          orderBy: desc(messages.createdAt),
          limit: 50,
        });
      },

      live: ({ input }) => ({
        topics: [`room:${input.roomId}:messages`],
      }),
    }),

    sendMessage: klasp.mutation({
      input: z.object({
        roomId: z.string(),
        text: z.string().min(1).max(4000),
      }),

      handler: async ({ input, ctx, klasp }) => {
        await assertRoomAccess(ctx.user.id, input.roomId);

        const message = await createMessage({
          roomId: input.roomId,
          userId: ctx.user.id,
          text: input.text,
        });

        await klasp.invalidate(`room:${input.roomId}:messages`);

        return message;
      },
    }),
  }),
});
```

### Client Examples

Pure React:

```tsx
const { data: messages } = useKlaspQuery(api.rooms.messages, { roomId });
const sendMessage = useKlaspMutation(api.rooms.sendMessage);

await sendMessage.mutate({ roomId, text });
```

TanStack Query:

```tsx
const messages = useKlaspTanStackQuery(api.rooms.messages, { roomId });
const sendMessage = useKlaspTanStackMutation(api.rooms.sendMessage);

await sendMessage.mutateAsync({ roomId, text });
```

Svelte:

```svelte
<script lang="ts">
  const messages = createKlaspQuery(api.rooms.messages, { roomId });
  const sendMessage = createKlaspMutation(api.rooms.sendMessage);
</script>
```

When `sendMessage` invalidates the room topic, every active client resource currently using `api.rooms.messages` for that room refreshes automatically, regardless of whether the app uses React state, TanStack Query, or Svelte stores.

---

## 8. Architecture

```txt
Frontend
  React / TanStack Query / Svelte
  Later: Vue / Solid / Next.js helpers
  Klasp client runtime
        │
        │ HTTP queries/mutations
        │ SSE realtime stream
        ▼
Backend
  Hono / Express / Fastify / SvelteKit / Next.js
  Klasp server SDK
  User auth and business logic
        │
        ├── Primary database
        │     Postgres / MySQL / SQLite / MongoDB / etc.
        │
        └── Redis
              Pub/Sub for cross-instance invalidation
              Later: Streams, presence, replay, feeds
```

### Query Flow

1. Client calls `useKlaspQuery`.
2. Klasp sends an HTTP request to the backend.
3. Server validates input and builds auth context.
4. Query handler runs user code.
5. Result is returned to the client.
6. The active client integration stores the result.
7. Klasp registers the active query resource against its live topics.

### Mutation + Invalidation Flow

1. Client calls a mutation.
2. Server validates input and runs user code.
3. Handler writes to the user’s database.
4. Handler calls `klasp.invalidate(topic)`.
5. Klasp publishes the invalidation to Redis.
6. All backend instances receive the invalidation.
7. Each instance forwards it to relevant connected clients.
8. Clients refresh matching active query resources through the relevant integration.
9. Affected queries refetch or update local state.

### Multi-Instance Support

Klasp must support multiple backend instances.

A mutation may run on instance A while clients are connected to instances B and C. Redis Pub/Sub distributes invalidations across all instances so every connected client can be notified.

---

## 9. Realtime Model

### MVP: Invalidation

The MVP should only require invalidation:

```ts
await klasp.invalidate(`room:${roomId}:messages`);
```

This means: “Something changed. Refetch affected queries.”

Benefits:

- simple
- database-agnostic
- safe
- easy to reason about
- works with multiple client integrations
- avoids patch complexity

This is the right starting point.

### Later: Events and Patches

Later, Klasp can support event payloads:

```ts
await klasp.publish(`room:${roomId}:messages`, {
  type: "message.created",
  message,
});
```

Clients could then refetch, patch the cache, append to a feed, or handle custom events.

### Later: Feeds, Presence, Replay

Future realtime primitives may include:

- append-only feeds
- notification streams
- job progress streams
- presence
- replayable events using Redis Streams
- missed-event recovery

These should come after the invalidation model is proven.

---

## 10. Transport Design

### HTTP for Queries and Mutations

Queries and mutations should use normal HTTP.

Reasons:

- easy to debug
- works with existing infra
- supports cookies/auth naturally
- keeps request/response semantics simple
- fits serverless and traditional backends

### SSE for Realtime MVP

The MVP should use Server-Sent Events for server-to-client invalidation.

Reasons:

- invalidation is server-to-client only
- simpler than WebSockets
- browser reconnect is built in
- easy to inspect and debug
- compatible with normal HTTP infrastructure

Endpoint:

```txt
GET /klasp/events
```

Example event:

```txt
event: klasp.invalidate
data: {"topic":"room:123:messages","version":42}
```

### WebSockets Later

WebSockets may be added later for high-frequency bidirectional use cases, but they should not be required for the MVP.

---

## 11. Redis Design

Redis is the realtime coordination layer.

### MVP Usage

Use Redis Pub/Sub for cross-instance invalidation.

Example channel:

```txt
klasp:{namespace}:invalidations
```

Example message:

```json
{
  "type": "invalidate",
  "topic": "room:123:messages",
  "version": 42,
  "timestamp": 1730000000000
}
```

Optional topic version counters can help clients detect missed updates:

```txt
klasp:{namespace}:topic:{topic}:version = 42
```

### Future Usage

Redis Streams can later support:

- replayable events
- feed history
- reconnect recovery
- durable job progress
- audit/event logs

Redis TTL keys/hashes can support presence and connection metadata later.

---

## 12. Auth and Authorization

Klasp should not own authentication. It should accept an auth hook that builds procedure context.

```ts
const klasp = createKlasp({
  auth: async ({ req }) => {
    const session = await getSession(req);
    return session ? { user: session.user, session } : null;
  },
});
```

Procedure authorization should live inside handlers:

```ts
handler: async ({ input, ctx }) => {
  if (!ctx.user) throw new KlaspError("UNAUTHORIZED");

  await assertProjectAccess(ctx.user.id, input.projectId);
  return getProject(input.projectId);
};
```

Topic authorization is critical.

By default, clients should not subscribe to arbitrary topics. They should only receive topics returned by queries they successfully executed.

Flow:

1. Client calls a query.
2. Server authenticates and authorizes the query.
3. Query returns data and live topic metadata.
4. Server associates the client/query with those topics.
5. Future invalidations for those topics can refresh that query.

Manual subscriptions should require explicit server-side authorization.

---

## 13. Client Runtime and Integrations

The core client should not be coupled to any one frontend cache library. It should manage protocol-level concerns:

- procedure calls
- SSE connection lifecycle
- active query registry
- query-to-topic mapping
- invalidation dispatch
- reconnect handling
- deterministic resource keys

Framework packages should adapt that runtime into native frontend primitives. This keeps the system extensible without forcing every app through TanStack Query just because one cache library had the decency to be popular.

### Core Client Runtime

`@klasp/client` should expose a low-level typed client:

```ts
const client = createKlaspClient<typeof api>({
  endpoint: "/klasp",
});

const messages = await client.query(api.rooms.messages, { roomId });
await client.mutation(api.rooms.sendMessage, { roomId, text });
```

The runtime should also expose subscription/resource primitives for integrations:

```ts
const resource = client.createQueryResource(api.rooms.messages, { roomId });

resource.subscribe((state) => {
  // integration updates React state, TanStack cache, Svelte store, etc.
});
```

Internally, Klasp maps:

```txt
resource key -> live topics
live topic -> active resources
```

When an invalidation arrives, the runtime asks affected resources to refresh.

### Pure React Integration

`@klasp/react` should work without TanStack Query. It should be enough for small apps, examples, and users who do not want another cache dependency.

```tsx
const { data, error, status, refetch } = useKlaspQuery(api.rooms.messages, {
  roomId,
});

const sendMessage = useKlaspMutation(api.rooms.sendMessage);
```

This integration can use React state internally. It should support:

- loading/error/data state
- refetch
- mutation status
- automatic realtime refresh
- optional stale-time/dedupe controls later

It does not need to become a full cache framework. Humanity already has enough of those.

### TanStack Query Integration

`@klasp/tanstack-query` should feel native for teams already using TanStack Query.

```tsx
const messages = useKlaspTanStackQuery(api.rooms.messages, { roomId });

const sendMessage = useKlaspTanStackMutation(api.rooms.sendMessage, {
  onSuccess: () => {
    // normal TanStack Query options still work
  },
});
```

This adapter should expose deterministic query keys:

```ts
api.rooms.messages.key({ roomId });
```

Example internal shape:

```ts
["klasp", "rooms.messages", { roomId }];
```

When an invalidation arrives, the adapter calls `queryClient.invalidateQueries` for matching resources. Optimistic updates should remain TanStack Query’s job.

### Svelte Integration

`@klasp/svelte` should expose store-friendly primitives.

```ts
const messages = createKlaspQuery(api.rooms.messages, { roomId });
const sendMessage = createKlaspMutation(api.rooms.sendMessage);
```

The query store should expose data, error, loading state, and refetch. Invalidations should refresh the store automatically.

SvelteKit-specific helpers can come later, but the first Svelte integration should be framework-agnostic enough to work in normal Svelte apps.

### Future Client Integrations

Likely later integrations:

- Vue
- Solid
- Next.js helpers
- SvelteKit load/action helpers
- React Server Components-aware helpers
- non-TypeScript generated clients

## Next.js should be treated mostly as deployment/framework glue around React and server routes, not as a separate client model at first.

## 14. API Surface

### Server Setup

```ts
import { createKlasp } from "@klasp/server";
import { redisAdapter } from "@klasp/redis";

export const klasp = createKlasp({
  transport: { path: "/klasp" },

  redis: redisAdapter({
    url: process.env.REDIS_URL,
  }),

  auth: async ({ req }) => {
    const user = await getUserFromRequest(req);
    return user ? { user } : null;
  },
});
```

### Hono Adapter

```ts
import { Hono } from "hono";
import { klaspHandler } from "@klasp/hono";

const app = new Hono();

app.route("/klasp", klaspHandler({ klasp, api }));
```

### Client Providers

Pure React:

```tsx
<KlaspProvider api={api} endpoint="/klasp">
  <App />
</KlaspProvider>
```

TanStack Query:

```tsx
<QueryClientProvider client={queryClient}>
  <KlaspTanStackProvider api={api} endpoint="/klasp" queryClient={queryClient}>
    <App />
  </KlaspTanStackProvider>
</QueryClientProvider>
```

Svelte:

```ts
const klasp = createKlaspSvelteClient<typeof api>({
  endpoint: "/klasp",
});
```

### Query

```ts
const getProject = klasp.query({
  input: z.object({ projectId: z.string() }),

  handler: async ({ input, ctx }) => {
    await assertProjectAccess(ctx.user.id, input.projectId);
    return getProjectById(input.projectId);
  },

  live: ({ input }) => ({
    topics: [`project:${input.projectId}`],
  }),
});
```

### Mutation

```ts
const updateProject = klasp.mutation({
  input: z.object({
    projectId: z.string(),
    name: z.string(),
  }),

  handler: async ({ input, ctx, klasp }) => {
    await assertProjectAccess(ctx.user.id, input.projectId);

    const project = await updateProjectName(input.projectId, input.name);

    await klasp.invalidate(`project:${input.projectId}`);

    return project;
  },
});
```

---

## 15. Package Structure

Suggested monorepo shape:

```txt
klasp/
  apps/
    docs/
    examples/
      hono-react-chat/
      hono-react-tanstack-chat/
      hono-svelte-chat/
      hono-react-dashboard/
    devtools/

  packages/
    core/
    server/
    client/
    react/
    tanstack-query/
    svelte/
    hono/
    redis/
    devtools-core/

  tooling/
    eslint-config/
    tsconfig/
```

Package responsibilities:

| Package                 | Responsibility                                  |
| ----------------------- | ----------------------------------------------- |
| `@klasp/core`           | Shared types, errors, protocol definitions      |
| `@klasp/server`         | Router, procedures, auth context, execution     |
| `@klasp/client`         | HTTP client, SSE client, event handling         |
| `@klasp/react`          | Pure React hooks backed by Klasp client runtime |
| `@klasp/tanstack-query` | TanStack Query adapter                          |
| `@klasp/svelte`         | Svelte stores and mutation helpers              |
| `@klasp/hono`           | Hono adapter                                    |
| `@klasp/redis`          | Redis adapter                                   |
| `@klasp/devtools-core`  | Shared devtools data/types                      |

Dependency direction should stay clean:

```txt
core
  ↑
server      client
  ↑           ↑
hono        react / tanstack-query / svelte
  ↑
redis adapter plugs into server
```

`@klasp/redis` should depend on `@klasp/server` only if the adapter interface lives there. Prefer defining adapter interfaces in `@klasp/core` so `@klasp/redis` can depend on `@klasp/core` and avoid coupling to the whole server package.

---

## 16. MVP Scope

### Must Include

Server:

- TypeScript server SDK
- router/query/mutation primitives
- Zod input validation
- auth context
- Hono adapter
- HTTP procedure endpoint
- SSE event endpoint
- explicit live topic declarations
- Redis Pub/Sub invalidation
- serializable errors

Client:

- framework-agnostic client runtime
- pure React SDK
- TanStack Query integration
- Svelte integration
- `useKlaspQuery` / `useKlaspMutation` for React
- TanStack-specific query/mutation hooks
- Svelte store/mutation helpers
- deterministic resource/query-key generation
- realtime invalidation handling
- SSE reconnect support

Redis:

- Pub/Sub adapter
- namespacing
- local Redis support

Docs/examples:

- Hono + pure React chat demo
- Hono + React + TanStack Query chat demo
- Hono + Svelte chat demo
- Redis setup guide
- auth guide
- topic naming guide
- deployment notes

### Should Not Include

- hosted cloud
- WebSockets
- automatic DB watching
- ORM adapters
- durable event replay
- feeds
- presence
- jobs
- rate limiting
- browser extension devtools
- server-side query caching
- billing or teams

The MVP is:

> **Type-safe queries and mutations, explicit live topics, Redis-backed invalidation, SSE delivery, and client-agnostic realtime refresh with first-class React, TanStack Query, and Svelte integrations.**

---

## 17. Devtools

Realtime systems are hard to debug because the important state is usually invisible.

Klasp should include basic observability early.

MVP logging should show:

- procedure calls
- invalidations
- active SSE connections
- topic subscriptions
- Redis connection status
- validation/auth errors

A local dashboard can come shortly after:

```txt
/klasp/dev
```

Useful dashboard views:

- active clients
- active topics
- query-to-topic mappings
- recent invalidations
- procedure timings
- failed calls
- reconnect events

Devtools are not decoration. They are part of making the abstraction trustworthy.

---

## 18. Technical Risks

### Redis Pub/Sub Message Loss

Redis Pub/Sub is fire-and-forget. If an instance is disconnected, it may miss invalidations.

Mitigation:

- refetch on reconnect
- optional topic version counters
- later Redis Streams for replay

### SSE Scaling

Long-lived SSE connections consume backend resources.

Mitigation:

- document scaling patterns
- use Redis for cross-instance fanout
- keep MVP suitable for small/medium apps
- later monetize hosted fanout/gateway

### Topic Authorization Bugs

Bad subscription rules can leak data.

Mitigation:

- clients cannot subscribe to arbitrary topics by default
- live topics come from successful query execution
- manual subscriptions require server authorization
- topic names are not treated as permission boundaries

### Weak Differentiation from tRPC

If realtime feels bolted on, Klasp becomes “tRPC with furniture.”

Mitigation:

- realtime invalidation must be core from day one
- no manual SSE setup in app code
- automatic query-topic mapping
- first-class React, TanStack Query, and Svelte integrations
- devtools visibility

### Weak Differentiation from Convex

Klasp should not compete with Convex as a full backend platform.

Mitigation:

- position around control and incremental adoption
- emphasize existing backend/database compatibility
- keep explicit topics instead of magical database tracking

---

## 19. Open Questions

### Type Sharing

Should the frontend import backend router types directly, or should Klasp generate a client?

Recommendation: start with direct type import, like tRPC. Add codegen later for separate repos or non-TypeScript clients.

### Adapter Interface Location

Where should Redis adapter types live?

Recommendation: put shared adapter contracts in `@klasp/core` so `@klasp/redis` does not need to depend on `@klasp/server`.

### Invalidation API Style

Should invalidation be imperative or returned as metadata?

Option A:

```ts
await klasp.invalidate(topic);
return result;
```

Option B:

```ts
return klasp.result(result, { invalidate: [topic] });
```

Recommendation: support imperative invalidation first. Add result helpers only if real examples prove they improve readability.

### Server-Side Query Caching

Should Klasp cache query results in Redis?

Recommendation: no for MVP. Client-side integrations own frontend state/caching. The user’s database owns source-of-truth state.

### Memory Adapter

Should Redis be required?

Recommendation: Redis should be required for realistic usage, but a memory adapter is useful for tests and local examples.

---

## 20. Implementation Plan

### Phase 0: Spike

Build the smallest proof:

- one server router
- one query
- one mutation
- HTTP procedure calls
- SSE stream
- Redis Pub/Sub invalidation
- React hook refreshing client state, plus a TanStack Query adapter invalidating query cache

Success criteria:

- two browser tabs update live
- no handwritten realtime app code
- types work end-to-end

### Phase 1: MVP Packages

Build:

- `@klasp/core`
- `@klasp/server`
- `@klasp/client`
- `@klasp/react`
- `@klasp/tanstack-query`
- `@klasp/svelte`
- `@klasp/hono`
- `@klasp/redis`

### Phase 2: Examples and Docs

Build examples:

- chat
- notifications
- job progress
- dashboard

Write docs for:

- getting started
- Hono setup
- React setup
- TanStack Query setup
- Svelte setup
- auth
- Redis
- deployment
- topic naming
- security

### Phase 3: Devtools

Add a local dashboard for active clients, topics, invalidations, errors, and procedure calls.

### Phase 4: Advanced Realtime

Add event publishing, cache patch helpers, Redis Streams, replay, presence, and feeds.

### Phase 5: Hosted Gateway Exploration

If the programming model proves useful, explore a hosted gateway for:

- managed fanout
- long-lived connection scaling
- production metrics
- event replay
- topic inspection
- hosted devtools
- rate limits

---

## 21. Success Criteria

Klasp is technically successful if:

- developers can add realtime query invalidation in under 15 minutes in React, TanStack Query, or Svelte
- no custom SSE/WebSocket code is needed in application code
- multi-tab realtime works
- multi-instance backend fanout works through Redis
- type inference feels tRPC-like
- React, TanStack Query, and Svelte integrations feel native
- auth and topic authorization are understandable
- debugging realtime state is easier than manual setups

Klasp is commercially promising if developers say:

- “I built this badly before.”
- “I would use this instead of wiring SSE manually.”
- “This is like tRPC but with realtime solved.”
- “This lets me avoid adopting Convex/Firebase.”
- “I can drop this into my existing app.”

---

## 22. Final Recommendation

Build Klasp as:

> **A TypeScript-first realtime API layer for existing backend apps, powered by Redis and usable from multiple frontend clients.**

The first version should focus narrowly on:

1. type-safe backend queries
2. type-safe mutations
3. explicit live topics
4. Redis-backed invalidation
5. SSE delivery
6. client runtime query refresh
7. React, TanStack Query, and Svelte integrations
8. Hono backend adapter

Do not start by building a database, ORM, hosting platform, sync engine, or full Convex competitor.

The product should prove one thing first:

> Developers can add reliable realtime updates to an existing TypeScript app from multiple frontend clients without writing the usual pile of WebSocket/SSE/cache-invalidation glue.
