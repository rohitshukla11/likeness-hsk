/**
 * The one creator on this deployment: a synthetic demo creator. Her portrait is a flat vector
 * illustration drawn for this project (public/demo/ana-reyes.svg), not a photo of anyone; her terms and
 * licences are read from HSK Chain.
 */
export const DEMO_CREATOR = {
  slug: "ana-reyes",
  name: "Ana Reyes",
  label: "Synthetic demo face",
  photo: "/demo/ana-reyes.svg",
  region: "Worldwide",
  bio: "A synthetic creator for the demo: her terms, licences and payments are real on HSK Chain testnet; her face is a synthetic illustration.",
} as const;

/** CreatorRegistry category bits (8 and up), as in contracts/src/Categories.sol. */
export const CATEGORY_LABELS = ["Advertising", "Social", "Editorial", "Entertainment", "Product"];
export const categoriesOf = (bits: number) => CATEGORY_LABELS.filter((_, i) => bits & (1 << (8 + i)));
