/**
 * The one creator on this deployment, the demo creator. Her portrait is the landing hero photo; her
 * terms and licences are read from HSK Chain.
 */
export const DEMO_CREATOR = {
  slug: "ana-reyes",
  name: "Ana Reyes",
  label: "Demo creator",
  photo: "/landing/hero-cutout.webp",
  region: "Worldwide",
  bio: "The demo creator: her terms, licences and payments are real on HSK Chain testnet.",
} as const;

/** CreatorRegistry category bits (8 and up), as in contracts/src/Categories.sol. */
export const CATEGORY_LABELS = ["Advertising", "Social", "Editorial", "Entertainment", "Product"];
export const categoriesOf = (bits: number) => CATEGORY_LABELS.filter((_, i) => bits & (1 << (8 + i)));
