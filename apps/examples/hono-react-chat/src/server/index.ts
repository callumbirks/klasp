import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { klaspHandler } from "@klasp/hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createChatApi } from "./chatApi.js";
import { createMemoryRealtimeAdapter } from "./realtime.js";

const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
const clientDist = resolve(process.cwd(), "dist/client");
const realtime = createMemoryRealtimeAdapter();
const { klasp, flatApi } = createChatApi(realtime);

const app = new Hono();

app.use(
    "/klasp/*",
    cors({
        origin: "http://localhost:5173",
    }),
);
app.route("/klasp", klaspHandler({ klasp, api: flatApi }));

app.get("/health", (c) =>
    c.json({
        ok: true,
        app: "hono-react-chat",
    }),
);

app.get("*", async (c) => {
    const asset = await readClientAsset(c.req.path);

    if (!asset) {
        return c.text(
            "React assets are not built yet. In development, open the Vite dev server at http://localhost:5173.",
            404,
        );
    }

    return new Response(asset.body, {
        headers: {
            "Content-Type": asset.contentType,
        },
    });
});

serve(
    {
        fetch: app.fetch,
        port: PORT,
    },
    (info) => {
        console.log(
            `Hono React chat server listening on http://localhost:${info.port}`,
        );
    },
);

interface ClientAsset {
    body: ArrayBuffer;
    contentType: string;
}

async function readClientAsset(pathname: string): Promise<ClientAsset | null> {
    const assetPath = resolveAssetPath(pathname);

    if (!assetPath) {
        return null;
    }

    const asset = await readFileOrNull(assetPath);

    if (asset) {
        return {
            body: asset,
            contentType: contentTypeFor(assetPath),
        };
    }

    if (extname(assetPath)) {
        return null;
    }

    const indexPath = join(clientDist, "index.html");
    const index = await readFileOrNull(indexPath);

    if (!index) {
        return null;
    }

    return {
        body: index,
        contentType: "text/html; charset=utf-8",
    };
}

function resolveAssetPath(pathname: string): string | null {
    const assetPath = pathname === "/" ? "/index.html" : pathname;
    const resolved = resolve(clientDist, `.${assetPath}`);
    const assetRelativePath = relative(clientDist, resolved);

    if (assetRelativePath.startsWith("..") || isAbsolute(assetRelativePath)) {
        return null;
    }

    return resolved;
}

async function readFileOrNull(path: string): Promise<ArrayBuffer | null> {
    try {
        const file = await readFile(path);

        return file.buffer.slice(
            file.byteOffset,
            file.byteOffset + file.byteLength,
        ) as ArrayBuffer;
    } catch {
        return null;
    }
}

function contentTypeFor(path: string): string {
    switch (extname(path)) {
        case ".css":
            return "text/css; charset=utf-8";
        case ".html":
            return "text/html; charset=utf-8";
        case "":
            return "text/javascript; charset=utf-8";
        case ".json":
            return "application/json; charset=utf-8";
        case ".svg":
            return "image/svg+xml";
        default:
            return "application/octet-stream";
    }
}
