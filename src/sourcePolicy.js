import { logger } from "./logger.js";

const DEFAULT_PROVIDER = "free_npi_registry";
const ALLOWED_FREE_PROVIDERS = new Set([
  DEFAULT_PROVIDER,
  "npi_registry",
  "cms_npi_registry",
]);

export function enforceSourcePolicy() {
  const freeOnlyMode = process.env.FREE_ONLY_MODE !== "0";
  const provider = (process.env.SCRAPER_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();

  if (!freeOnlyMode) {
    logger.warn("FREE_ONLY_MODE is disabled. Normal deployments should keep it enabled.");
    return;
  }

  if (!ALLOWED_FREE_PROVIDERS.has(provider)) {
    throw new Error(
      `Free-only source policy failed. Unsupported provider '${provider}'. Allowed providers: ${[...ALLOWED_FREE_PROVIDERS].join(", ")}`
    );
  }

  logger.info("Free-only source policy passed", { provider });
}
