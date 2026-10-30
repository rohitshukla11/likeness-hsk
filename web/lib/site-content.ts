/**
 * Marketing copy that is data, not code. Every number here is a real measurement with its source;
 * testimonials are real quotes only. An empty list hides the section entirely.
 */

export const MEASUREMENTS = {
  /**
   * Not measured on HSK Chain: null hides the card (no number without a measurement).
   */
  registerMs: {
    value: null as number | null,
    source: "not measured on HSK Chain: the card is hidden",
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

export const BUILT_ON = ["HSK Chain", "HSP", "A2A", "AP2", "MCP", "Permit2", "Safe"];
