import { loadSettings } from "./config.js";
import { MinecraftWorker } from "./bot.js";

let worker: MinecraftWorker | undefined;

try {
  const settings = loadSettings();
  worker = new MinecraftWorker(settings);
  worker.start();
} catch (error) {
  console.error(`[Startup] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

const shutdown = async (signal: string): Promise<void> => {
  console.info(`[Startup] Received ${signal}; shutting down`);
  await worker?.stop();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));