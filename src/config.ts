import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ModuleName = "mining" | "farming" | "guarding";

export interface Coordinates {
  x: number;
  y: number;
  z: number;
}

export interface AiSettings {
  enabled: boolean;
  model: string;
}

export interface BotSettings {
  server: {
    host: string;
    port: number;
    version?: string;
  };
  bot: {
    username: string;
    auth?: "offline" | "microsoft";
  };
  access: {
    commandUsernames: string[];
  };
  home: {
    coordinates: Coordinates;
    chest: Coordinates;
  };
  modules: Record<ModuleName, boolean>;
  ai: AiSettings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid settings: ${path} must be a non-empty string`);
  }
  return value.trim();
}

function readRequiredNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid settings: ${path} must be a finite number`);
  }
  return value;
}

function readCoordinates(value: unknown, path: string): Coordinates {
  if (!isRecord(value)) {
    throw new Error(`Invalid settings: ${path} must be an object`);
  }
  return {
    x: readRequiredNumber(value.x, `${path}.x`),
    y: readRequiredNumber(value.y, `${path}.y`),
    z: readRequiredNumber(value.z, `${path}.z`),
  };
}

function readAiSettings(value: unknown): AiSettings {
  if (value === undefined) {
    // Omitted entirely means existing settings.json files (from before this
    // feature existed) keep working with AI-based chat parsing turned off.
    return { enabled: false, model: "gemini-flash-latest" };
  }
  if (!isRecord(value)) {
    throw new Error("Invalid settings: ai must be an object");
  }
  if (typeof value.enabled !== "boolean") {
    throw new Error("Invalid settings: ai.enabled must be true or false");
  }
  const model = value.model === undefined ? "gemini-flash-latest" : readRequiredString(value.model, "ai.model");
  return { enabled: value.enabled, model };
}

function parseSettings(value: unknown): BotSettings {
  if (!isRecord(value)) {
    throw new Error("Invalid settings: the root value must be an object");
  }

  const server = value.server;
  const bot = value.bot;
  const access = value.access;
  const home = value.home;
  const modules = value.modules;

  if (!isRecord(server) || !isRecord(bot) || !isRecord(access) || !isRecord(home) || !isRecord(modules)) {
    throw new Error("Invalid settings: server, bot, access, home, and modules are required objects");
  }

  if (!Array.isArray(access.commandUsernames) || access.commandUsernames.length === 0) {
    throw new Error("Invalid settings: access.commandUsernames must contain at least one username");
  }

  const commandUsernames = access.commandUsernames.map((username, index) =>
    readRequiredString(username, `access.commandUsernames[${index}]`),
  );

  const auth = bot.auth ?? "offline";
  if (auth !== "offline" && auth !== "microsoft") {
    throw new Error('Invalid settings: bot.auth must be "offline" or "microsoft"');
  }

  const moduleNames: ModuleName[] = ["mining", "farming", "guarding"];
  const parsedModules = Object.fromEntries(
    moduleNames.map((moduleName) => {
      if (typeof modules[moduleName] !== "boolean") {
        throw new Error(`Invalid settings: modules.${moduleName} must be true or false`);
      }
      return [moduleName, modules[moduleName]];
    }),
  ) as Record<ModuleName, boolean>;

  return {
    server: {
      host: readRequiredString(server.host, "server.host"),
      port: readRequiredNumber(server.port, "server.port"),
      ...(server.version === undefined ? {} : { version: readRequiredString(server.version, "server.version") }),
    },
    bot: {
      username: readRequiredString(bot.username, "bot.username"),
      auth,
    },
    access: { commandUsernames },
    home: {
      coordinates: readCoordinates(home.coordinates, "home.coordinates"),
      chest: readCoordinates(home.chest, "home.chest"),
    },
    modules: parsedModules,
    ai: readAiSettings(value.ai),
  };
}

export function loadSettings(): BotSettings {
  const settingsPath = resolve(process.cwd(), "settings.json");
  let raw: string;

  try {
    raw = readFileSync(settingsPath, "utf8");
    console.info("[Config] Loaded settings.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`[Config] Could not read settings.json: ${(error as Error).message}`);
    }
    raw = process.env.MINECRAFT_SETTINGS_JSON ?? "";
    if (!raw) {
      throw new Error("[Config] settings.json was not found and MINECRAFT_SETTINGS_JSON is not set");
    }
    console.info("[Config] Loaded MINECRAFT_SETTINGS_JSON");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`[Config] Settings must be valid JSON: ${(error as Error).message}`);
  }

  return parseSettings(parsed);
}