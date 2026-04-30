import {
    createKlaspEventsResponse,
    createKlaspRpcResponse,
    type Klasp,
    type KlaspApi,
} from "@klasp/server";
import { Hono } from "hono";

export interface KlaspHonoHandlerOptions {
    klasp: Klasp;
    api: KlaspApi;
}

export function klaspHandler(options: KlaspHonoHandlerOptions): Hono {
    const app = new Hono();

    app.post("/rpc", (c) =>
        createKlaspRpcResponse({
            klasp: options.klasp,
            api: options.api,
            request: c.req.raw,
        }),
    );

    app.get("/events", (c) =>
        createKlaspEventsResponse({
            klasp: options.klasp,
            request: c.req.raw,
        }),
    );

    return app;
}
