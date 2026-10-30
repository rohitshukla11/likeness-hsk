/**
 * The offline mode of HSP Agentic Payment: an MCP server with the same eight tools as HashKey's QA
 * server, run in-process (in-memory transport) against the local devnet, so the agents, the approvals
 * and the app work without HashKey. It does what the guide says HSP does: builds the eip712 with the
 * Gateway's own nonce and a 5-minute quote, inserts the payer's signature, and broadcasts the transfer
 * itself as the Gateway. Its tool and field names follow the guide; HashKey's live schemas are the
 * authority for the real server (the client checks them on every call). Never used on mainnet.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type Address, type Chain, createWalletClient, type Hex, http, type LocalAccount, parseAbi, type PublicClient, recoverTypedDataAddress } from "viem";
import { z } from "zod";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { HspAgentic, QUOTE_EXPIRED_CODE, type ToolInfo } from "./client.js";
import { typedData } from "./payer.js";

const tokenAbi = parseAbi(["function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)"]);
const permit2Abi = parseAbi([
  "function permitTransferFrom(((address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit, (address to, uint256 requestedAmount) transferDetails, address owner, bytes signature)",
]);

export interface EmulatorOptions {
  chain: Chain;
  rpcUrl: string;
  publicClient: PublicClient;
  /** The emulated Gateway's wallet: broadcasts the transfers (and is the Permit2 spender). */
  executor: LocalAccount;
  network: string;
  token: { address: Address; decimals: number; symbol: string; protocol: "eip3009" | "permit2"; name?: string; version?: string };
  permit2?: Address;
  quoteSeconds?: number;
  stepDelayMs?: number;
}

interface Order {
  flowId: string;
  paymentRequestId: string;
  merchantName: string;
  payTo: Address;
  cart: { contents: Record<string, unknown> };
  totalRaw: bigint;
  status: string;
  statusReason?: string;
  payer?: Address;
  txHash?: Hex;
  quote?: { expiresAt: number; eip712: ReturnType<typeof eip712For>; cartHash: string };
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const fail = (code: number, msg: string) => ({ content: [{ type: "text" as const, text: `${code}: ${msg}` }], isError: true });

function eip712For(o: EmulatorOptions, order: Order, payer: Address, deadline: bigint) {
  const nonce = `0x${randomBytes(32).toString("hex")}` as Hex; // the Gateway assigns the nonce
  if (o.token.protocol === "eip3009") {
    return {
      domain: { name: o.token.name ?? o.token.symbol, version: o.token.version ?? "2", chainId: o.chain.id, verifyingContract: o.token.address },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: { from: payer, to: order.payTo, value: order.totalRaw.toString(), validAfter: "0", validBefore: deadline.toString(), nonce },
    };
  }
  return {
    domain: { name: "Permit2", chainId: o.chain.id, verifyingContract: o.permit2! },
    types: {
      PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    primaryType: "PermitTransferFrom",
    message: { permitted: { token: o.token.address, amount: order.totalRaw.toString() }, spender: o.executor.address, nonce: BigInt(nonce).toString(), deadline: deadline.toString() },
  };
}

/** 6-decimal USD ("0.05") to the token's raw units, exact. */
function rawOfUsd(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`not a USD amount: ${value}`);
  const frac = (m[2] ?? "").padEnd(decimals, "0");
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) throw new Error(`more precision than the token has: ${value}`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.slice(0, decimals) || "0");
}

export class HspAgenticEmulator {
  readonly orders = new Map<string, Order>();
  readonly server: McpServer;
  constructor(readonly o: EmulatorOptions) {
    if (o.token.protocol === "permit2" && !o.permit2) throw new Error("the Permit2 rail needs Permit2's address");
    this.server = new McpServer({ name: "hsp-agentic-payment (emulator)", version: "0.1.0" });
    const s = this.server;
    const flow = { flow_id: z.string() };

    s.registerTool("get_chain_config", { description: "Supported networks and tokens (emulator: the local devnet)", inputSchema: {} }, async () =>
      text({ networks: [{ network: o.network, chain_id: o.chain.id, tokens: [{ symbol: o.token.symbol, address: o.token.address, decimals: o.token.decimals, payment_protocol: o.token.protocol }] }] }),
    );

    s.registerTool(
      "create_order",
      { description: "Create an order from a cart mandate (amount in USD)", inputSchema: { merchant_name: z.string(), pay_to: z.string(), cart_mandate: z.object({ contents: z.record(z.string(), z.unknown()) }) } },
      async (a) => {
        if (!/^0x[0-9a-fA-F]{40}$/.test(a.pay_to)) return fail(10001, "pay_to must be a 42-character 0x address");
        const c = a.cart_mandate.contents as { id?: string; cart_expiry?: string; payment_request?: { method_data?: { supported_methods?: string; data?: { x402Version?: number } }[]; details?: { id?: string; total?: { amount?: { currency?: string; value?: string } } } } };
        const total = c.payment_request?.details?.total?.amount;
        if (!c.id || !c.cart_expiry || !c.payment_request?.method_data?.length || !c.payment_request.details) return fail(10001, "cart_mandate.contents needs id, cart_expiry, payment_request.method_data and details");
        if (total?.currency !== "USD" || !total.value) return fail(10001, "amount.currency must be USD");
        if (c.payment_request.method_data.some((m) => m.supported_methods !== "https://www.x402.org/" || m.data?.x402Version !== 2)) return fail(10001, "method_data must be x402 v2");
        const order: Order = {
          flowId: `FLOW-${randomUUID()}`,
          paymentRequestId: c.payment_request.details.id ?? `PR-${randomUUID()}`,
          merchantName: a.merchant_name,
          payTo: a.pay_to as Address,
          cart: a.cart_mandate as Order["cart"],
          totalRaw: rawOfUsd(total.value, o.token.decimals),
          status: "payment-required",
        };
        this.orders.set(order.flowId, order);
        return text({ flow_id: order.flowId, payment_request_id: order.paymentRequestId, payment_url: `emulator://checkout/${order.flowId}` });
      },
    );

    s.registerTool("get_order", { description: "Read an order", inputSchema: flow }, async (a) => {
      const order = this.orders.get(a.flow_id);
      if (!order) return fail(10003, "unknown flow_id");
      return text({ flow_id: order.flowId, payment_request_id: order.paymentRequestId, merchant_name: order.merchantName, pay_to: order.payTo, status: order.status, gas_fee_advanced: true, cart_mandate: order.cart });
    });

    s.registerTool("estimate_fee", { description: "Network fee estimate (the emulated platform advances it)", inputSchema: flow }, async () => text({ gas_fee: "0", gas_fee_advanced: true }));

    s.registerTool(
      "prepare_payment",
      { description: "Lock a quote and return the eip712 to sign", inputSchema: { flow_id: z.string(), payer: z.string(), protocol: z.enum(["eip3009", "permit2"]) } },
      async (a) => {
        const order = this.orders.get(a.flow_id);
        if (!order) return fail(10003, "unknown flow_id");
        if (order.status !== "payment-required") return fail(40001, `order is ${order.status}`);
        if (a.protocol !== o.token.protocol) return fail(10001, `this token uses ${o.token.protocol}`);
        const expiresAt = Date.now() + (o.quoteSeconds ?? 300) * 1000;
        const eip712 = eip712For(o, order, a.payer as Address, BigInt(Math.floor(expiresAt / 1000) + 60));
        const cartHash = createHash("sha256").update(JSON.stringify(order.cart.contents)).digest("hex");
        order.payer = a.payer as Address;
        order.quote = { expiresAt, eip712, cartHash };
        return text({
          eip712,
          cart_hash: cartHash,
          token_total_raw: order.totalRaw.toString(),
          quote_expires_at: new Date(expiresAt).toISOString(),
          pay_to: order.payTo,
          payer: a.payer,
          payment_request_id: order.paymentRequestId,
          payment_payload: { x402Version: 2, scheme: "exact", network: o.network, payload: { signature: "" } },
          payment_mandate_contents: { payment_mandate_id: order.flowId, payment_details_id: order.paymentRequestId },
        });
      },
    );

    s.registerTool(
      "finalize_payment",
      { description: "Insert the signature; returns payment_mandate_json", inputSchema: { signature: z.string(), payment_payload: z.unknown(), payment_mandate_contents: z.unknown(), cart_hash: z.string() } },
      async (a) => {
        const order = [...this.orders.values()].find((x) => x.quote?.cartHash === a.cart_hash);
        if (!order?.quote) return fail(10003, "no quote for this cart_hash");
        const signer = await recoverTypedDataAddress({ ...typedData(order.quote.eip712 as never), signature: a.signature as Hex });
        if (signer.toLowerCase() !== order.payer?.toLowerCase()) return fail(10002, "signature isn't the payer's");
        const payload = { ...(a.payment_payload as Record<string, unknown>), payload: { ...((a.payment_payload as { payload?: object }).payload ?? {}), signature: a.signature } };
        const mandate = { payment_mandate_contents: a.payment_mandate_contents, payment_payload: payload, payment_hash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), flow_id: order.flowId };
        return text({ payment_mandate_json: JSON.stringify(mandate) });
      },
    );

    s.registerTool("submit_payment", { description: "Submit the finalized payment mandate", inputSchema: { payment_mandate_json: z.string() } }, async (a) => {
      let m: { flow_id?: string; payment_payload?: { payload?: { signature?: Hex } } };
      try {
        m = JSON.parse(a.payment_mandate_json);
      } catch {
        return fail(10001, "payment_mandate_json isn't JSON");
      }
      const order = m.flow_id ? this.orders.get(m.flow_id) : undefined;
      const sig = m.payment_payload?.payload?.signature;
      if (!order?.quote || !sig) return fail(10003, "unknown payment");
      if (order.status !== "payment-required") return fail(40001, `order is ${order.status}`);
      if (Date.now() > order.quote.expiresAt) return fail(QUOTE_EXPIRED_CODE, "quote expired; prepare the payment again");
      order.status = "payment-submitted";
      void this.execute(order, sig);
      return text({ status: "payment-submitted", flow_id: order.flowId, payment_request_id: order.paymentRequestId });
    });

    s.registerTool(
      "query_payment",
      { description: "Payment status and team attribution", inputSchema: { flow_id: z.string().optional(), payment_request_id: z.string().optional(), expected_merchant_name: z.string() } },
      async (a) => {
        const order = (a.flow_id && this.orders.get(a.flow_id)) || [...this.orders.values()].find((x) => x.paymentRequestId === a.payment_request_id);
        if (!order) return fail(10003, "unknown payment");
        return text({
          flow_id: order.flowId,
          payment_request_id: order.paymentRequestId,
          attribution_verified: a.expected_merchant_name === order.merchantName,
          payment: { status: order.status, status_reason: order.statusReason ?? "", tx_signature: order.txHash ?? "", network: o.network, to_pay_address: order.payTo, payer_address: order.payer ?? "" },
        });
      },
    );
  }

  /** A client connected over an in-memory transport: the same HspAgentic the agents use for HashKey's server. */
  async client(): Promise<HspAgentic> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await this.server.connect(serverSide);
    return HspAgentic.connect(clientSide, "emulator");
  }

  /** As the Gateway: broadcast the signed authorization, then advance the states. */
  private async execute(order: Order, signature: Hex) {
    const o = this.o;
    const step = () => new Promise((r) => setTimeout(r, o.stepDelayMs ?? 50));
    const m = order.quote!.eip712.message as Record<string, unknown>;
    const wallet = createWalletClient({ account: o.executor, chain: o.chain, transport: http(o.rpcUrl) });
    try {
      for (const s of ["payment-verified", "payment-processing"]) {
        await step();
        order.status = s;
      }
      const hash =
        o.token.protocol === "eip3009"
          ? await wallet.writeContract({
              address: o.token.address,
              abi: tokenAbi,
              functionName: "transferWithAuthorization",
              args: [m.from as Address, m.to as Address, BigInt(m.value as string), BigInt(m.validAfter as string), BigInt(m.validBefore as string), m.nonce as Hex, signature],
            })
          : await wallet.writeContract({
              address: o.permit2!,
              abi: permit2Abi,
              functionName: "permitTransferFrom",
              args: [{ permitted: { token: o.token.address, amount: order.totalRaw }, nonce: BigInt(m.nonce as string), deadline: BigInt(m.deadline as string) }, { to: order.payTo, requestedAmount: order.totalRaw }, order.payer!, signature],
            });
      const r = await o.publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("reverted");
      order.txHash = hash;
      order.status = "payment-included";
      for (const s of ["payment-safe", "payment-finalized"]) {
        await step();
        order.status = s;
      }
    } catch (e) {
      order.status = "payment-failed";
      order.statusReason = `on-chain execution failed: ${(e as Error).message.split("\n")[0]}`;
    }
  }
}

/** The emulator's eight tools and input schemas (no chain needed): the baseline the live schemas are diffed against. */
export async function emulatorTools(): Promise<ToolInfo[]> {
  const em = new HspAgenticEmulator({
    chain: { id: 0 } as Chain,
    rpcUrl: "",
    publicClient: {} as PublicClient,
    executor: privateKeyToAccount(generatePrivateKey()),
    network: "emulator",
    token: { address: "0x0000000000000000000000000000000000000000", decimals: 6, symbol: "TOKEN", protocol: "eip3009" },
  });
  const c = await em.client();
  try {
    return [...c.tools.values()];
  } finally {
    await c.close();
  }
}

