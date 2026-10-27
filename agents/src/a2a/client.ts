import { randomUUID } from "node:crypto";
import type { AgentCard, JsonRpcResponse, Message, Part, Task } from "./types.js";

export async function fetchAgentCard(baseUrl: string, fetchFn: typeof fetch = fetch): Promise<AgentCard> {
  const res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/.well-known/agent-card.json`);
  if (!res.ok) throw new Error(`agent card: HTTP ${res.status}`);
  return (await res.json()) as AgentCard;
}

export function userMessage(parts: Part[], contextId?: string): Message {
  return { kind: "message", role: "user", messageId: randomUUID(), parts, ...(contextId ? { contextId } : {}) };
}

/** JSON-RPC `message/send` to the agent's A2A endpoint (card.url). */
export async function sendMessage(card: AgentCard, message: Message, fetchFn: typeof fetch = fetch): Promise<Task> {
  const res = await fetchFn(card.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "message/send", params: { message } }),
  });
  const body = (await res.json()) as JsonRpcResponse;
  if ("error" in body) throw new Error(`A2A error ${body.error.code}: ${body.error.message}`);
  if (body.result.kind !== "task") throw new Error("expected a task");
  return body.result;
}
