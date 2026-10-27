/**
 * The parts of the A2A protocol (https://a2a-protocol.org, v0.3) these agents use: the agent card,
 * JSON-RPC `message/send`, and tasks with data artifacts. AP2 rides on A2A as an extension
 * (https://github.com/google-agentic-commerce/AP2): the creator's agent is the AP2 merchant, and the
 * Cart Mandate travels as a data part keyed "ap2.mandates.CartMandate".
 */
export const A2A_PROTOCOL_VERSION = "0.3.0";
export const AP2_EXTENSION = "https://github.com/google-agentic-commerce/ap2/tree/v0.1";
export const CART_MANDATE_KEY = "ap2.mandates.CartMandate";
export const PAYMENT_MANDATE_KEY = "ap2.mandates.PaymentMandate";

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  preferredTransport: "JSONRPC";
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    extensions?: { uri: string; description?: string; required?: boolean; params?: Record<string, unknown> }[];
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
}

export type Part = { kind: "text"; text: string } | { kind: "data"; data: Record<string, unknown> };

export interface Message {
  kind: "message";
  role: "user" | "agent";
  messageId: string;
  parts: Part[];
  taskId?: string;
  contextId?: string;
}

export type TaskState = "submitted" | "working" | "input-required" | "completed" | "failed" | "rejected" | "canceled";

export interface Artifact {
  artifactId: string;
  name: string;
  parts: Part[];
}

export interface Task {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: TaskState; message?: Message; timestamp: string };
  artifacts?: Artifact[];
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: Task | Message }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string; data?: unknown } };

/** The first data part of a message, or undefined. */
export function dataOf(m: { parts: Part[] }): Record<string, unknown> | undefined {
  for (const p of m.parts) if (p.kind === "data") return p.data;
  return undefined;
}

export function textOf(m: { parts: Part[] }): string {
  return m.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("\n");
}
