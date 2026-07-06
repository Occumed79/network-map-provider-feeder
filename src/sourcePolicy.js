import { logger } from "./logger.js";

const DEFAULT_PROVIDER = "parallel_mapped_http";
const ALLOWED_MAP_PROVIDERS = new Set([
  DEFAULT_PROVIDER,
  "bing_maps_http",
  "google_maps_http",
  "apple_maps_http",
]);

export function enforceSourcePolicy() {
  const freeOnlyMode = process.env.FREE_ONLY_MODE !== "0";
  const provider = (process.env.SCRAPER_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();

  if (!freeOnlyMode) {
    logger.warn("FREE_ONLY_MODE is disabled. Normal deployments should keep it enabled.");
    return;
  }

  if (!ALLOWED_MAP_PROVIDERS.has(provider)) {
    throw new Error(
      `Mapped-source policy failed. Unsupported provider '${provider}'. Allowed providers: ${[...ALLOWED_MAP_PROVIDERS].join(", ")}`
    );
  }

  logger.info("Mapped-source policy passed", { provider });
}
