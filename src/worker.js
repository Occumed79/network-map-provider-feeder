import { createServer } from "http";
import { end } from "./db.js";
import { handleDashboardRequest } from "./dashboard.js";
import { logger } from "./logger.js";
import { ensureFeederSchema, validateSchema } from "./schema.js";

const ENABLE_SCHEMA_BOOTSTRAP = process.env.ENABLE_SCHEMA_BOOTSTRAP !== "0";
const VALIDATE_SCHEMA_ON_START = process.env.VALIDATE_SCHEMA_ON_START !== "0";

const health = {
  startedAt: new Date().toISOString(),
  ready: false,
  status: "starting",
  mode: "dashboard_and_scrapy_ingestion",
  schemaReady: false,
  lastLoopAt: null,
  lastJobAt: null,
  lastJobId: null,
  lastWarning: null,
  lastError: null,
};

function startHealthServer() {
  const port = parseInt(process.env.PORT || "0", 10);
  if (!port) return null;

  const server = createServer(async (req, res) => {
    try {
      const result = await handleDashboardRequest(req, health);
      res.writeHead(result.statusCode, result.headers);
      if (result.body && typeof result.body.pipe === "function") result.body.pipe(res);
      else res.end(result.body);
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  server.listen(port, "0.0.0.0", () => {
    logger.info("Dashboard server listening", { port });
  });
  return server;
}

async function main() {
  const healthServer = startHealthServer();
  logger.info("Provider feeder dashboard starting", {
    mode: health.mode,
    schemaBootstrap: ENABLE_SCHEMA_BOOTSTRAP,
    validateSchema: VALIDATE_SCHEMA_ON_START,
    dashboardServer: Boolean(healthServer),
  });

  if (ENABLE_SCHEMA_BOOTSTRAP) await ensureFeederSchema();
  if (VALIDATE_SCHEMA_ON_START) await validateSchema();

  health.schemaReady = true;
  health.ready = true;
  health.status = "running";
  health.lastWarning = "Legacy map scraper loop has been removed. Use Scrapy crawlers for provider ingestion.";

  let running = true;
  const shutdown = async () => {
    if (!running) return;
    logger.info("Shutting down dashboard service...");
    health.status = "stopping";
    running = false;
    if (healthServer) healthServer.close();
    await end();
    logger.info("Dashboard service stopped.");
  };

  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}

main().catch((err) => {
  health.status = "fatal";
  health.lastError = err.message;
  logger.error("Fatal dashboard service error", { error: err.message });
  process.exit(1);
});
