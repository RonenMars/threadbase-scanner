import type { ContentTier } from "./types";

export const DEFAULT_TIERS: Record<string, ContentTier> = {
  standard: { name: "standard", previewMax: 200, snippetMax: 5_000 },
  full: { name: "full", previewMax: 1_200, snippetMax: 50_000 },
};

export function resolveTier(
  tierName: string,
  customTiers?: Record<string, ContentTier>,
): ContentTier {
  const tier = customTiers?.[tierName] ?? DEFAULT_TIERS[tierName];
  if (!tier) {
    throw new Error(
      `Unknown tier "${tierName}". Available: ${Object.keys({ ...DEFAULT_TIERS, ...customTiers }).join(", ")}`,
    );
  }
  return tier;
}
