import { encodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { optionalReturnOk } from "../src/chain/erc20.js";

describe("SafeERC20-style return data", () => {
  it("accepts no return data (classic USDT) and an encoded true", () => {
    expect(optionalReturnOk(undefined)).toBe(true);
    expect(optionalReturnOk("0x")).toBe(true);
    expect(optionalReturnOk(encodeAbiParameters([{ type: "bool" }], [true]))).toBe(true);
  });

  it("refuses an encoded false and data that isn't a bool", () => {
    expect(optionalReturnOk(encodeAbiParameters([{ type: "bool" }], [false]))).toBe(false);
    expect(optionalReturnOk("0x1234")).toBe(false);
  });
});
