import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import mineflayer from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Movements as MovementsType } from "mineflayer-pathfinder";
import { type BotSettings, type Coordinates, type ModuleName } from "./config.js";
import { TaskQueue, type Task } from "./task-queue.js";
import { GeminiCommandInterpreter, type InterpretedCommand } from "./ai.js";

const require = createRequire(import.meta.url);
const { goals, Movements, pathfinder } = require("mineflayer-pathfinder") as typeof import("mineflayer-pathfinder");

const DEFAULT_MINE_TARGETS = [
  "coal_ore",
  "iron_ore",
  "copper_ore",
  "gold_ore",
  "redstone_ore",
  "lapis_ore",
  "diamond_ore",
  "emerald_ore",
  "deepslate_coal_ore",
  "deepslate_iron_ore",
  "deepslate_copper_ore",
  "deepslate_gold_ore",
  "deepslate_redstone_ore",
  "deepslate_lapis_ore",
  "deepslate_diamond_ore",
  "deepslate_emerald_ore",
];

const CROP_TARGETS = new Set([
  "wheat",
  "carrots",
  "potatoes",
  "beetroots",
  "nether_wart",
  "sweet_berry_bush",
  "cocoa",
]);

const HOSTILE_NAMES = new Set([
  "blaze",
  "cave_spider",
  "creeper",
  "drowned",
  "enderman",
  "endermite",
  "evoker",
  "ghast",
  "guardian",
  "husk",
  "magma_cube",
  "phantom",
  "piglin_brute",
  "pillager",
  "ravager",
  "skeleton",
  "slime",
  "spider",
  "stray",
  "vex",
  "vindicator",
  "witch",
  "wither_skeleton",
  "zoglin",
  "zombie",
  "zombie_villager",
]);

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

// Tools we keep equipped rather than deposit — anything else in the inventory
// gets dropped in the home chest after a mining or farming pass.
const KEEP_ITEM_PATTERN = /(_pickaxe|_axe|_shovel|_hoe|_sword)$/;

function formatCoordinates(coordinates: Coordinates): string {
  return `${Math.round(coordinates.x)}, ${Math.round(coordinates.y)}, ${Math.round(coordinates.z)}`;
}

function positionKey(position: { x: number; y: number; z: number }): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MinecraftWorker {
  private bot: Bot | undefined;
  private movements: MovementsType | undefined;
  private readonly queue = new TaskQueue();
  private loopRunning = false;
  private shuttingDown = false;
  private readonly ai: GeminiCommandInterpreter | undefined;

  constructor(private readonly settings: BotSettings) {
    if (settings.ai.enabled) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.warn(
          "[AI] ai.enabled is true in settings but GEMINI_API_KEY is not set; free-form chat parsing stays off.",
        );
      } else {
        this.ai = new GeminiCommandInterpreter(apiKey, settings.ai.model);
        console.info(`[AI] Free-form chat parsing enabled (model: ${settings.ai.model}).`);
      }
    }
  }

  start(): void {
    this.bot = mineflayer.createBot({
      host: this.settings.server.host,
      port: this.settings.server.port,
      username: this.settings.bot.username,
      auth: this.settings.bot.auth,
      ...(this.settings.server.version ? { version: this.settings.server.version } : {}),
    });

    this.bot.loadPlugin(pathfinder);
    this.bot.once("spawn", () => {
      if (!this.bot) return;
      this.movements = new Movements(this.bot);
      this.bot.pathfinder.setMovements(this.movements);
      console.info("[Bot] spawned and ready");
      console.info(`[Bot] Home: ${formatCoordinates(this.settings.home.coordinates)}`);
      void this.runQueue();
    });

    this.bot.on("chat", (username, message) => {
      void this.handleChat(username, message);
    });

    this.bot.on("kicked", (reason) => {
      console.error(`[Bot] kicked: ${reason}`);
    });

    this.bot.on("error", (error) => {
      console.error(`[Bot] error: ${error.message}`);
    });

    this.bot.on("end", (reason) => {
      this.movements = undefined;
      this.loopRunning = false;
      console.warn(`[Bot] connection ended: ${reason}`);
      if (!this.shuttingDown) {
        console.warn("[Bot] Exiting so the process manager can restart the worker");
        process.exitCode = 1;
      }
    });
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    this.queue.stop();
    this.bot?.pathfinder.setGoal(null);
    this.bot?.quit("Worker shutting down");
    await sleep(100);
  }

  private isAuthorized(username: string): boolean {
    return this.settings.access.commandUsernames.some(
      (allowedUsername) => allowedUsername.toLowerCase() === username.toLowerCase(),
    );
  }

  private async handleChat(username: string, message: string): Promise<void> {
    if (!this.bot || username === this.bot.username) return;
    const trimmed = message.trim();
    if (!trimmed) return;

    if (!this.isAuthorized(username)) {
      if (trimmed.startsWith("!")) {
        console.warn(`[Chat] Ignored command from unauthorized user ${username}`);
      }
      return;
    }

    if (trimmed.startsWith("!")) {
      const [command, ...args] = trimmed.split(/\s+/);
      this.runCommand(username, command.toLowerCase(), args[0]);
      return;
    }

    // Not a "!command" — only worth a Gemini call if free-form parsing is configured.
    if (!this.ai) return;

    let interpreted: InterpretedCommand | null;
    try {
      interpreted = await this.ai.interpret(trimmed);
    } catch (error) {
      console.warn(`[AI] Gemini interpretation failed: ${errorMessage(error)}`);
      return;
    }

    if (!interpreted || interpreted.action === "unknown") {
      this.bot.chat(`Not sure what you mean, ${username}. Try !mine, !farm, !guard, !stop, or !status.`);
      return;
    }

    this.runCommand(username, `!${interpreted.action}`, interpreted.blockName);
  }

  private runCommand(username: string, command: string, arg?: string): void {
    if (!this.bot) return;
    switch (command) {
      case "!mine":
        this.enqueueModule(username, "mining", { kind: "mine", ...(arg ? { blockName: arg } : {}) });
        break;
      case "!farm":
        this.enqueueModule(username, "farming", { kind: "farm" });
        break;
      case "!guard":
        this.enqueueModule(username, "guarding", { kind: "guard" });
        break;
      case "!stop":
        this.queue.stop();
        this.bot.pathfinder.setGoal(null);
        this.bot.chat("Stopped. Queue cleared; returning to idle.");
        break;
      case "!status":
        this.bot.chat(this.statusMessage());
        break;
      default:
        break;
    }
  }

  private enqueueModule(username: string, moduleName: ModuleName, task: Task): void {
    if (!this.bot) return;
    if (!this.settings.modules[moduleName]) {
      this.bot.chat(`${moduleName} is disabled.`);
      return;
    }
    const position = this.queue.enqueue(task);
    this.bot.chat(`${task.kind} queued by ${username} (position ${position}).`);
    void this.runQueue();
  }

  private statusMessage(): string {
    if (!this.bot) return "State: offline | HP: 0 | Inventory: unavailable";
    const inventorySlots = this.bot.inventory.slots.filter(Boolean).length;
    const totalSlots = this.bot.inventory.slots.length;
    const health = Math.max(0, Math.round(this.bot.health * 10) / 10);
    const state = this.queue.current ? `${this.queue.state} (${this.queue.pending.length} queued)` : "idle";
    return `State: ${state} | HP: ${health}/20 | Inventory: ${inventorySlots}/${totalSlots} slots`;
  }

  private async runQueue(): Promise<void> {
    if (this.loopRunning || !this.bot) return;
    this.loopRunning = true;

    try {
      while (this.bot && !this.shuttingDown) {
        const task = this.queue.takeNext();
        if (!task) break;
        const cancellationVersion = this.queue.cancellationVersion;
        try {
          await this.executeTask(task, cancellationVersion);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[Task] ${task.kind} failed: ${message}`);
          this.bot.chat(`${task.kind} task failed: ${message.slice(0, 80)}`);
        } finally {
          this.queue.finishCurrent();
          if (this.bot) this.bot.pathfinder.setGoal(null);
        }
      }
    } finally {
      this.loopRunning = false;
    }
  }

  private async executeTask(task: Task, cancellationVersion: number): Promise<void> {
    switch (task.kind) {
      case "mine":
        await this.mine(task.blockName, cancellationVersion);
        return;
      case "farm":
        await this.farm(cancellationVersion);
        return;
      case "guard":
        await this.guard(cancellationVersion);
        return;
    }
  }

  private isCancelled(cancellationVersion: number): boolean {
    return !this.bot || this.shuttingDown || this.queue.wasCancelled(cancellationVersion);
  }

  private async moveNear(coordinates: Coordinates, range: number, cancellationVersion: number): Promise<void> {
    if (!this.bot || this.isCancelled(cancellationVersion)) return;
    await this.bot.pathfinder.goto(new goals.GoalNear(coordinates.x, coordinates.y, coordinates.z, range));
  }

  private async depositAtChest(cancellationVersion: number): Promise<void> {
    if (!this.bot || this.isCancelled(cancellationVersion)) return;
    const chestCoordinates = this.settings.home.chest;
    const chestBlock = this.bot.blockAt(chestCoordinates);

    if (!chestBlock || !/chest|barrel|shulker_box/.test(chestBlock.name)) {
      console.warn(
        `[Bot] No chest/barrel found at home.chest (${formatCoordinates(chestCoordinates)}); skipping deposit.`,
      );
      return;
    }

    await this.moveNear(chestCoordinates, 2, cancellationVersion);
    if (this.isCancelled(cancellationVersion)) return;

    const bot = this.bot;
    const container = await bot.openContainer(chestBlock).catch((error: unknown) => {
      console.warn(`[Bot] Could not open chest: ${errorMessage(error)}`);
      return undefined;
    });
    if (!container) return;

    try {
      const itemsToDeposit = bot.inventory.items().filter((item) => !KEEP_ITEM_PATTERN.test(item.name));
      for (const item of itemsToDeposit) {
        if (this.isCancelled(cancellationVersion)) break;
        try {
          await container.deposit(item.type, null, item.count);
        } catch (error) {
          console.warn(`[Bot] Could not deposit ${item.name}: ${errorMessage(error)}`);
        }
      }
    } finally {
      container.close();
    }
  }

  private async mine(blockName: string | undefined, cancellationVersion: number): Promise<void> {
    if (!this.bot) return;
    this.bot.chat(blockName ? `Mining ${blockName}.` : "Mining nearby ores.");
    let minedCount = 0;
    const skipped = new Set<string>();

    while (!this.isCancelled(cancellationVersion) && minedCount < 16) {
      const block = this.bot.findBlock({
        matching: (candidate) =>
          Boolean(
            candidate &&
              !skipped.has(positionKey(candidate.position)) &&
              (blockName ? candidate.name === blockName : DEFAULT_MINE_TARGETS.includes(candidate.name)),
          ),
        maxDistance: 32,
      });
      if (!block) break;

      await this.moveNear(block.position, 3, cancellationVersion);
      if (this.isCancelled(cancellationVersion)) return;
      const currentBlock = this.bot.blockAt(block.position);
      if (!currentBlock || !this.bot.canDigBlock(currentBlock)) {
        // Can't dig this one right now (wrong tool, protected, etc.) — never retry it
        // in this task, or findBlock would just hand it back and spin forever.
        skipped.add(positionKey(block.position));
        continue;
      }
      try {
        await this.bot.dig(currentBlock);
        minedCount += 1;
      } catch (error) {
        skipped.add(positionKey(block.position));
        console.warn(`[Bot] Failed to dig block at ${formatCoordinates(block.position)}: ${errorMessage(error)}`);
      }
    }

    if (this.isCancelled(cancellationVersion)) return;

    if (minedCount > 0) {
      this.bot.chat(`Mining complete: ${minedCount} block${minedCount === 1 ? "" : "s"}. Heading to the chest.`);
      await this.depositAtChest(cancellationVersion);
    } else {
      this.bot.chat("No matching, diggable blocks nearby.");
    }
  }

  private async farm(cancellationVersion: number): Promise<void> {
    if (!this.bot) return;
    this.bot.chat("Starting a farming pass.");
    let harvestedCount = 0;
    const skipped = new Set<string>();

    while (!this.isCancelled(cancellationVersion) && harvestedCount < 32) {
      const crop = this.bot.findBlock({
        matching: (candidate) =>
          Boolean(candidate && !skipped.has(positionKey(candidate.position)) && CROP_TARGETS.has(candidate.name)),
        maxDistance: 32,
      });
      if (!crop) break;
      await this.moveNear(crop.position, 3, cancellationVersion);
      if (this.isCancelled(cancellationVersion)) return;
      const currentBlock = this.bot.blockAt(crop.position);
      if (!currentBlock || !this.bot.canDigBlock(currentBlock)) {
        skipped.add(positionKey(crop.position));
        continue;
      }
      try {
        await this.bot.dig(currentBlock);
        harvestedCount += 1;
      } catch (error) {
        skipped.add(positionKey(crop.position));
        console.warn(`[Bot] Failed to harvest block at ${formatCoordinates(crop.position)}: ${errorMessage(error)}`);
      }
    }

    if (this.isCancelled(cancellationVersion)) return;

    if (harvestedCount > 0) {
      this.bot.chat(`Farming complete: harvested ${harvestedCount} crop${harvestedCount === 1 ? "" : "s"}. Heading to the chest.`);
      await this.depositAtChest(cancellationVersion);
    } else {
      this.bot.chat("No crops found nearby.");
    }
  }

  private async guard(cancellationVersion: number): Promise<void> {
    if (!this.bot) return;
    this.bot.chat("Guard duty started.");
    const home = this.settings.home.coordinates;

    while (!this.isCancelled(cancellationVersion)) {
      const hostile = this.findNearestHostile();
      if (hostile) {
        await this.fight(hostile, cancellationVersion);
      } else {
        const position = this.bot.entity.position;
        const distanceFromHome = Math.hypot(position.x - home.x, position.y - home.y, position.z - home.z);
        if (distanceFromHome > 8) {
          await this.moveNear(home, 5, cancellationVersion);
        }
        await sleep(500);
      }
    }
  }

  private findNearestHostile(): Entity | undefined {
    if (!this.bot) return undefined;
    return this.bot.nearestEntity((entity) => {
      const distance = entity.position.distanceTo(this.bot!.entity.position);
      return entity.type === "mob" && entity.name !== undefined && HOSTILE_NAMES.has(entity.name) && distance <= 12;
    }) ?? undefined;
  }

  private async fight(hostile: Entity, cancellationVersion: number): Promise<void> {
    if (!this.bot) return;
    const startedAt = Date.now();
    while (!this.isCancelled(cancellationVersion) && hostile.isValid && Date.now() - startedAt < 20_000) {
      const distance = hostile.position.distanceTo(this.bot.entity.position);
      if (distance > 4) {
        this.bot.pathfinder.setGoal(new goals.GoalFollow(hostile, 2));
      } else {
        this.bot.pathfinder.setGoal(null);
        await this.bot.lookAt(hostile.position.offset(0, hostile.height / 2, 0), true);
        this.bot.attack(hostile);
        await sleep(700);
      }
    }
    this.bot.pathfinder.setGoal(null);
  }
}