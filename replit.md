# Minecraft Worker Bot

A TypeScript Mineflayer bot that accepts whitelisted in-game chat commands for mining, farming, guarding, and status checks.

## Run & Operate

- `npm install` — install dependencies
- `npm start` — connect the bot using `settings.json` or `MINECRAFT_SETTINGS_JSON`
- `npm run dev` — run with TypeScript watch mode
- `npm run typecheck` — check the TypeScript source

## Stack

- Node.js 22+
- TypeScript
- Mineflayer and Mineflayer Pathfinder
- Plain npm package, deployable from the repository root

## Where things live

- `src/config.ts` — settings loading and validation
- `src/bot.ts` — Mineflayer connection and task execution
- `src/task-queue.ts` — sequential task queue and cancellation
- `settings.example.json` — safe local configuration template
- `railway.json` — Railway build and start commands

## Architecture decisions

- `settings.json` is ignored because it can contain server credentials and command-user names.
- Railway can inject the complete configuration through `MINECRAFT_SETTINGS_JSON`, so no secrets need to be committed.
- Commands are authorized before they can enqueue work; the queue runs one task at a time.
- `!stop` invalidates the current task so long-running movement and harvesting loops return to idle.
- A block the bot can't dig (wrong tool, protected, dig throws) is added to a per-task skip set instead of being retried forever, so `!mine`/`!farm` can't spin on one stuck block.
- On a successful mining or farming pass, the bot walks to `home.chest` and deposits everything except equipped tools (pickaxe/axe/shovel/hoe/sword). If no chest/barrel/shulker box is at those coordinates, it logs a warning and keeps the loot instead of failing the task.
- Optional Gemini-powered free-form chat parsing (`src/ai.ts`, `GeminiCommandInterpreter`): when `ai.enabled` is true and `GEMINI_API_KEY` is set, non-`!` chat from a whitelisted player is classified into one of the five known commands via a schema-constrained Gemini call, then dispatched through the same `runCommand` path as an exact `!command`. Exact `!commands` never touch Gemini — this is purely additive.

## Product

The bot joins a Minecraft server, logs a clear spawn-ready signal, and responds to authorized player chat commands:

| Command | Effect |
| --- | --- |
| `!mine <block_name>` or `!mine` | Queue a mining task |
| `!farm` | Queue a farming pass |
| `!guard` | Stay near home and fight nearby hostiles |
| `!stop` | Clear the queue, stop current work, and return to idle |
| `!status` | Reply with state, health, and inventory fullness |

## Gotchas

- The bot must be able to reach the Minecraft server from the machine running it.
- For Microsoft-authenticated servers, set `"auth": "microsoft"` and complete Mineflayer's device-code login flow on first startup.
- The server version is optional, but setting it explicitly avoids protocol-version guessing.
- `ai.enabled: true` without `GEMINI_API_KEY` set just disables free-form parsing (a warning is logged); it does not crash the bot or affect `!commands`.
- Every non-`!` message from a whitelisted player triggers a paid Gemini API call when AI parsing is on — there's no local rate limiting on this yet.
- Railway builds run `npm ci`, which hard-fails on a lockfile that doesn't match `package.json`. Always run `npm install` and commit the updated `package-lock.json` together with any `package.json` dependency change — a stale lockfile causes silent build failures that show up as `sh: 1: <tool>: not found` in Deploy Logs, not as an obvious build error.
