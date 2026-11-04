/**
 * Marketing copy that is data, not code. Every number here is a real measurement with its source;
 * testimonials are real quotes only. An empty list hides the section entirely.
 */

export const MEASUREMENTS = {
  /**
   * Not measured on the live chain: null hides the card (no number without a measurement).
   */
  registerMs: {
    value: null as number | null,
    source: "not measured on the live chain: the card is hidden",
  },
  /** By construction: a render is anchored only after HspSettlement recorded its payment, and files are released only after that. */
  rendersWithReceipt: {
    value: 100,
    source: "HspSettlement.anchorRender requires a recorded payment; the app releases a file only after its receipt",
  },
} as const;

export type Testimonial = { quote: string; name: string; role: string };

/** Real, attributed quotes only. Leave empty until there are some: the section is then not rendered. */
export const TESTIMONIALS: Testimonial[] = [];

// The live rail: Circle's USDC on Ethereum Sepolia through HashKey QA, paid by EIP-3009 authorizations.
export const BUILT_ON = ["HSP", "HSK Chain", "Ethereum Sepolia", "A2A", "AP2", "MCP", "EIP-3009", "Safe"];
