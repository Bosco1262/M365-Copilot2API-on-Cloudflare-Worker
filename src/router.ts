// Minimal request router: exact paths plus optional prefixes, mirroring the
// flat mux of the upstream Go server.

import type { Env } from "./env";

export type Handler = (ctx: HandlerCtx) => Promise<Response>;

export interface HandlerCtx {
  env: Env;
  req: Request;
  url: URL;
  requestId: string;
  waitUntil(promise: Promise<unknown>): void;
}

interface Route {
  path: string;
  prefix?: boolean;
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  on(path: string, handler: Handler): this {
    this.routes.push({ path, handler });
    return this;
  }

  prefix(pathPrefix: string, handler: Handler): this {
    this.routes.push({ path: pathPrefix, prefix: true, handler });
    return this;
  }

  async dispatch(ctx: HandlerCtx): Promise<Response | null> {
    const path = ctx.url.pathname;
    for (const r of this.routes) {
      if (r.prefix ? path.startsWith(r.path) : path === r.path) {
        return r.handler(ctx);
      }
    }
    return null; // not matched
  }
}
