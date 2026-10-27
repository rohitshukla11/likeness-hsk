import type { KeyObject } from "node:crypto";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { signMerchantJwt, verifyMerchantJwt, type MerchantClaims } from "./jwt.js";

/** AP2 Cart Mandate, as the HSP Gateway takes it (docs: cart-mandate.md; Go SDK types/ap2.go). */
export const X402 = "https://www.x402.org/";

export interface Amount {
  currency: "USD";
  value: string; // decimal string
}

export interface PaymentItem {
  label: string;
  amount: Amount;
}

export interface X402MethodData {
  supported_methods: typeof X402;
  data: {
    x402Version: 2;
    network: string;
    chain_id: number;
    contract_address: string;
    pay_to: string;
    coin: string;
  };
}

export interface CartContents {
  id: string; // cart_mandate_id (ID1)
  user_cart_confirmation_required: boolean;
  payment_request: {
    method_data: X402MethodData[];
    details: {
      id: string; // payment_request_id (ID2)
      display_items: PaymentItem[];
      total: PaymentItem;
    };
  };
  cart_expiry: string; // RFC 3339
  merchant_name: string;
}

export interface CartMandate {
  contents: CartContents;
  merchant_authorization: string;
}

/** 6-decimal stablecoin base units to the USD decimal string the cart carries ("0.05"). */
export function usdValue(units: bigint, decimals = 6): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  let frac = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** The inverse, exact: "0.05" → 50000n. Rejects more precision than the token has. */
export function unitsOf(value: string, decimals = 6): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`not a decimal amount: ${value}`);
  const frac = m[2] ?? "";
  if (frac.replace(/0+$/, "").length > decimals) throw new Error(`more than ${decimals} decimals: ${value}`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0").slice(0, decimals) || "0");
}

export interface CartInput {
  cartId: string;
  paymentRequestId: string;
  merchantName: string;
  network: string; // HSP network name, e.g. "hashkey" (mainnet) or "hashkey-testnet"
  chainId: number;
  token: string;
  coin: string; // "USDC" / "USDT"
  payTo: string;
  priceUnits: bigint;
  itemLabel: string;
  expiresAt: Date;
}

export function buildCartContents(i: CartInput): CartContents {
  const amount: Amount = { currency: "USD", value: usdValue(i.priceUnits) };
  return {
    id: i.cartId,
    user_cart_confirmation_required: false, // the brand's payment agent confirms against its policy
    payment_request: {
      method_data: [
        {
          supported_methods: X402,
          data: {
            x402Version: 2,
            network: i.network,
            chain_id: i.chainId,
            contract_address: i.token,
            pay_to: i.payTo,
            coin: i.coin,
          },
        },
      ],
      details: {
        id: i.paymentRequestId,
        display_items: [{ label: i.itemLabel, amount }],
        total: { label: "Total", amount },
      },
    },
    cart_expiry: i.expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    merchant_name: i.merchantName,
  };
}

export function cartHash(contents: CartContents): string {
  return sha256Hex(canonicalJson(contents));
}

export function signCart(contents: CartContents, key: KeyObject, opts: { issuer: string; audience?: string }): CartMandate {
  return {
    contents,
    merchant_authorization: signMerchantJwt(key, { issuer: opts.issuer, cartHash: cartHash(contents), audience: opts.audience }),
  };
}

/** The payer's check: the merchant signed exactly these contents, and they haven't expired. */
export function verifyCart(
  cart: CartMandate,
  merchantPublicKey: string | KeyObject,
  opts: { audience?: string; now?: number } = {},
): MerchantClaims {
  const claims = verifyMerchantJwt(cart.merchant_authorization, merchantPublicKey, opts);
  if (claims.cart_hash !== cartHash(cart.contents)) throw new Error("cart_hash does not match the cart contents");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Date.parse(cart.contents.cart_expiry) / 1000 <= now) throw new Error("cart expired");
  return claims;
}
