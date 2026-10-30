/**
 * The one creator on this deployment: a synthetic demo creator. The portrait is one of the landing
 * illustrations (not a real person); her terms and licences are read from HSK Chain.
 */
export const DEMO_CREATOR = {
  slug: "ana-reyes",
  name: "Ana Reyes",
  label: "Synthetic demo creator",
  photo: "/landing/portrait-curly.png",
  region: "Worldwide",
  bio: "A synthetic creator for the demo: her terms, licences and payments are real on HSK Chain testnet; her face is an illustration.",
} as const;

/** CreatorRegistry category bits (8 and up), as in contracts/src/Categories.sol. */
export const CATEGORY_LABELS = ["Advertising", "Social", "Editorial", "Entertainment", "Product"];
export const categoriesOf = (bits: number) => CATEGORY_LABELS.filter((_, i) => bits & (1 << (8 + i)));
