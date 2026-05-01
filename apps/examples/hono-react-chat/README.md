# Hono React Chat

Realtime chat example using `@klasp/hono` on a Hono server and `@klasp/react` in a React client.

## Run

From the repository root:

```sh
pnpm install
pnpm --filter hono-react-chat dev
```

Open <http://localhost:5173> in two browser tabs. Send a message in one tab and the other tab should refresh automatically.

In development, Vite serves the React app from port `5173` and the Hono server listens on port `8787`. The React app calls `http://localhost:8787/klasp` directly so the SSE stream does not go through Vite's HTTP proxy.

## How It Works

- The Hono server mounts Klasp at `/klasp`, which exposes `/klasp/rpc` and `/klasp/events`.
- The React app wraps the UI in `KlaspProvider` with `endpoint="/klasp"`.
- `chat.listMessages` is a live query that registers the current room topic.
- `chat.sendMessage` appends to the in-memory store and invalidates that room topic.
- The SSE invalidation tells each tab to refetch the live query.

This example uses an in-memory message store and in-memory realtime adapter so it stays easy to run locally. For multi-instance deployments, replace the local adapter with `@klasp/redis` or another shared `KlaspRealtimeAdapter`.

## Build And Preview

```sh
pnpm --filter hono-react-chat build
pnpm --filter hono-react-chat preview
```

Preview serves the built React assets and Klasp API from <http://localhost:8787>.
