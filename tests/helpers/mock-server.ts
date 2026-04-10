import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { AddressInfo } from "node:net";

/** A single mock route definition. */
export interface MockRoute {
  method: string;
  /** Exact pathname or a regex tested against the pathname. */
  path: string | RegExp;
  handler: (req: MockRequest, res: MockResponse) => void | Promise<void>;
}

/** Parsed request information passed to mock handlers. */
export interface MockRequest {
  method: string;
  url: string;
  pathname: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  /** Parse body as JSON. Returns an empty object for an empty body. */
  json<T = unknown>(): T;
  /** Regex match results (when the route path was a RegExp). */
  match?: RegExpMatchArray;
}

/** Fluent response helper passed to mock handlers. */
export interface MockResponse {
  status(code: number): MockResponse;
  header(name: string, value: string): MockResponse;
  json(data: unknown): void;
  send(body: string): void;
  end(): void;
}

/** A record of a single request received by the mock server. */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** Handle returned by startMockServer(). */
export interface MockServer {
  /** Full origin URL, e.g. "http://127.0.0.1:54321". No trailing slash. */
  url: string;
  /** Port the server is listening on. */
  port: number;
  /** Log of all received requests; assertions can inspect this. */
  requests: RecordedRequest[];
  /** Shut down the server. Resolves once closed. */
  close(): Promise<void>;
  /** Clear the request log. */
  reset(): void;
}

/**
 * Start a tiny HTTP mock server on 127.0.0.1 with a random port.
 *
 * Routes are matched in the order given. The first route whose method AND
 * path (string equality OR regex test against the pathname) match wins.
 * Unmatched requests return HTTP 404 with `{"error":"Not Found"}`.
 *
 * Every received request is logged to `server.requests` so tests can assert
 * what the code under test actually called. Call `server.reset()` between
 * test cases when sharing a server.
 */
export async function startMockServer(routes: MockRoute[]): Promise<MockServer> {
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    handleRequest(req, res, routes, requests).catch((err) => {
      // Last-resort error handler: don't crash the server on handler errors.
      try {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
        }
        res.end(JSON.stringify({ error: "Mock handler error", message: String(err) }));
      } catch {
        // swallow
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    requests,
    reset() {
      requests.length = 0;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  routes: MockRoute[],
  requests: RecordedRequest[],
): Promise<void> {
  const method = (req.method || "GET").toUpperCase();
  const rawUrl = req.url || "/";
  const parsed = new URL(rawUrl, "http://127.0.0.1");
  const pathname = parsed.pathname;

  const query: Record<string, string> = {};
  for (const [k, v] of parsed.searchParams.entries()) {
    query[k] = v;
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers[k.toLowerCase()] = v;
    else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
  }

  const body = await readBody(req);

  requests.push({ method, path: rawUrl, headers, body });

  // Find first matching route.
  let matched: MockRoute | undefined;
  let regexMatch: RegExpMatchArray | undefined;
  for (const route of routes) {
    if (route.method.toUpperCase() !== method) continue;
    if (typeof route.path === "string") {
      if (route.path === pathname) {
        matched = route;
        break;
      }
    } else {
      const m = pathname.match(route.path);
      if (m) {
        matched = route;
        regexMatch = m;
        break;
      }
    }
  }

  if (!matched) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Not Found", method, pathname }));
    return;
  }

  const mockReq: MockRequest = {
    method,
    url: rawUrl,
    pathname,
    query,
    headers,
    body,
    match: regexMatch,
    json<T = unknown>(): T {
      if (!body) return {} as T;
      return JSON.parse(body) as T;
    },
  };

  let statusCode = 200;
  const responseHeaders: Record<string, string> = {};
  let sent = false;

  const mockRes: MockResponse = {
    status(code: number) {
      statusCode = code;
      return mockRes;
    },
    header(name: string, value: string) {
      responseHeaders[name.toLowerCase()] = value;
      return mockRes;
    },
    json(data: unknown) {
      if (sent) return;
      sent = true;
      res.statusCode = statusCode;
      if (!responseHeaders["content-type"]) {
        responseHeaders["content-type"] = "application/json";
      }
      for (const [k, v] of Object.entries(responseHeaders)) {
        res.setHeader(k, v);
      }
      res.end(JSON.stringify(data));
    },
    send(bodyStr: string) {
      if (sent) return;
      sent = true;
      res.statusCode = statusCode;
      for (const [k, v] of Object.entries(responseHeaders)) {
        res.setHeader(k, v);
      }
      res.end(bodyStr);
    },
    end() {
      if (sent) return;
      sent = true;
      res.statusCode = statusCode;
      for (const [k, v] of Object.entries(responseHeaders)) {
        res.setHeader(k, v);
      }
      res.end();
    },
  };

  await matched.handler(mockReq, mockRes);

  if (!sent) {
    // Handler forgot to send. Default to 200 with empty body.
    res.statusCode = statusCode;
    for (const [k, v] of Object.entries(responseHeaders)) {
      res.setHeader(k, v);
    }
    res.end();
  }
}
