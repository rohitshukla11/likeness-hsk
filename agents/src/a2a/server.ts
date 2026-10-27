import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentCard, JsonRpcRequest, JsonRpcResponse, Message, Task } from "./types.js";

export interface A2AHandler {
  card(): AgentCard;
  onMessage(message: Message): Promise<Task>;
  /** Extra routes (e.g. the HSP webhook). Return true if handled. */
  route?(req: IncomingMessage, res: ServerResponse, rawBody: string): Promise<boolean>;
}

export async function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/**
 * GET /.well-known/agent-card.json and JSON-RPC 2.0 `message/send` on POST /a2a.
 * Errors use JSON-RPC codes: -32700 parse, -32600 invalid request, -32601 method, -32603 internal.
 */
export function serveA2A(handler: A2AHandler): Server {
  return createServer(async (req, res) => {
    try {
      const raw = req.method === "POST" ? await readBody(req) : "";
      if (handler.route && (await handler.route(req, res, raw))) return;
      if (req.method === "GET" && req.url === "/.well-known/agent-card.json") return sendJson(res, 200, handler.card());
      if (req.method !== "POST" || req.url !== "/a2a") return sendJson(res, 404, { error: "not found" });

      let rpc: JsonRpcRequest;
      try {
        rpc = JSON.parse(raw);
      } catch {
        return sendJson(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } } satisfies JsonRpcResponse);
      }
      if (rpc.jsonrpc !== "2.0" || rpc.id === undefined) {
        return sendJson(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } } satisfies JsonRpcResponse);
      }
      if (rpc.method !== "message/send") {
        return sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "method not found" } } satisfies JsonRpcResponse);
      }
      const message = (rpc.params as { message?: Message } | undefined)?.message;
      if (!message || message.kind !== "message" || !Array.isArray(message.parts)) {
        return sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: "invalid params" } } satisfies JsonRpcResponse);
      }
      const task = await handler.onMessage(message);
      return sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id, result: task } satisfies JsonRpcResponse);
    } catch (e) {
      return sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: e instanceof Error ? e.message : "internal error" } });
    }
  });
}

export function listen(server: Server, port = 0): Promise<string> {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const a = server.address();
      resolve(`http://127.0.0.1:${typeof a === "object" && a ? a.port : port}`);
    });
  });
}
