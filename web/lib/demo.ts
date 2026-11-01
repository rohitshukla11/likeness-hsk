/**
 * Ana Reyes: the synthetic demo creator, a flat vector illustration drawn for this project (not a photo
 * of anyone). Her terms and licences are read from HSK Chain. Real creators sign in with Google and
 * verify their YouTube channel; they come from /api/creators.
 */
import type { CreatorView } from "./api";

export const DEMO_CREATOR = {
  slug: "ana-reyes",
  name: "Ana Reyes",
  label: "Synthetic demo creator",
  photo: "/demo/ana-reyes.svg",
  region: "Worldwide",
  bio: "A synthetic demo creator: her face is an illustration; her terms, licences and payments are real on HSK Chain testnet.",
} as const;

/** CreatorRegistry category bits (8 and up), as in contracts/src/Categories.sol. */
export const CATEGORY_LABELS = ["Advertising", "Social", "Editorial", "Entertainment", "Product"];
export const categoriesOf = (bits: number) => CATEGORY_LABELS.filter((_, i) => bits & (1 << (8 + i)));

/** How a creator is shown: Ana's illustration, or a real creator's consented photo and YouTube check. */
export function displayOf(c: CreatorView) {
  if (c.synthetic) return { ...DEMO_CREATOR, verified: false };
  return {
    slug: c.address.toLowerCase(),
    name: c.name ?? "Creator",
    label: c.label ? `Verified YouTube creator · ${c.label}` : "Verified YouTube creator",
    photo: c.photo ?? "",
    region: "Worldwide",
    bio: `A real creator, signed in with Google; YouTube channel ${c.youtube?.title ?? ""} verified by Likeness. Their terms, licences and payments are on HSK Chain testnet.`,
    verified: true,
  };
}
