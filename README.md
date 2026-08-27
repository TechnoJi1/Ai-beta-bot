# Minecraft Worker Bot

A small TypeScript worker bot built with [Mineflayer](https://github.com/PrismarineJS/mineflayer). It connects to a Minecraft server, waits for authorized players to issue commands in chat, and performs queued mining, farming, or guarding work.

## Requirements

- Node.js 22 or newer
- A Minecraft Java server reachable from the machine running the bot
- A bot account name

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the example configuration:

   ```bash
   cp settings.example.json settings.json
   ```

3. Edit `settings.json` with your server address, bot name, authorized usernames, home coordinates, and module toggles.

4. Start the worker:

   ```bash
   npm start
   ```

   A successful connection logs:

   ```text
   [Bot] spawned and ready
   ```

For a development loop with automatic TypeScript restarts:

```bash
npm run dev
```

Check the source without connecting:

```bash
npm run typecheck
```

## Railway deployment

This repository is intentionally a flat, single-package npm project. The root `railway.json` uses:

- Build: `npm install`
- Start: `npm start`

Because `settings.json` is gitignored, set the complete configuration as a Railway environment variable named `MINECRAFT_SETTINGS_JSON`. It must be a minified JSON string with the same shape as `settings.example.json`, for example:

```json
{"server":{"host":"your-server.example","port":25565,"version":"1.20.4"},"bot":{"username":"worker_bot","auth":"offline"},"access":{"commandUsernames":["YourMinecraftUsername"]},"home":{"coordinates":{"x":0,"y":64,"z":0},"chest":{"x":1,"y":64,"z":0}},"modules":{"mining":true,"farming":true,"guarding":true}}
```

Do not commit real server credentials or the contents of `settings.json`.

### Keep `package-lock.json` in sync

Railway's build step runs `npm ci`, which fails the entire build if `package-lock.json` doesn't exactly match `package.json`. **Any time you add, remove, or change a dependency, regenerate and commit the lockfile in the same commit as the `package.json` change:**

```bash
npm install
git add package.json package-lock.json
git commit -m "..."
```

If a deploy crashes with something like `sh: 1: tsx: not found` (or any other "command not found" for a listed dependency), it almost always means the lockfile is stale and `npm ci` silently failed before `node_modules` was ever populated — check the **Build Logs** tab in Railway (not Deploy Logs) to confirm.

## Chat commands

Commands only run when the sender appears in `access.commandUsernames`. Usernames are matched case-insensitively.

| Command | Effect |
| --- | --- |
| `!mine <block_name>` or `!mine` | Queue a mining task. With a block name, the bot targets that block; without one, it searches for nearby ores. On success, deposits everything except tools in the chest at `home.chest`. |
| `!farm` | Queue a farming pass that harvests nearby crops, then deposits the harvest at `home.chest`. |
| `!guard` | Stay near `home.coordinates` and auto-fight nearby hostile mobs. |
| `!stop` | Clear the queue, stop current work, and return to idle. |
| `!status` | Reply with the bot state, HP, and inventory fullness. |

## Authentication

Use `"auth": "offline"` for offline-mode servers. For Microsoft-authenticated servers, use `"auth": "microsoft"`; Mineflayer will show a device-code login prompt on first connection.

## Free-form chat via Gemini (optional)

By default the bot only responds to exact `!command` messages. You can optionally let it interpret plain-English chat too — e.g. a whitelisted player typing "go mine some diamonds" or "keep watch" — by turning on the `ai` block in `settings.json`:

```json
"ai": {
  "enabled": true,
  "model": "gemini-flash-latest"
}
```

Then set a `GEMINI_API_KEY` environment variable (get one from Google AI Studio). It is **not** stored in `settings.json`/`MINECRAFT_SETTINGS_JSON` — set it as its own environment variable, the same way you'd set it on Railway.

Behavior:

- `!mine`, `!farm`, `!guard`, `!stop`, `!status` always work exactly as before, whether or not `ai.enabled` is set — the exact-command path never calls Gemini.
- Any other message from a whitelisted player is only sent to Gemini if `ai.enabled` is `true` and `GEMINI_API_KEY` is set. Gemini classifies it into one of the five commands (or "unknown"); the bot then runs it exactly like the equivalent `!command`.
- If Gemini can't confidently classify the message, times out (8s), or the API call fails, the bot either replies asking for one of the known commands or silently ignores the message — it never crashes a task over this.
- If `ai.enabled` is `true` but `GEMINI_API_KEY` isn't set, the bot logs a warning at startup and free-form parsing stays off; `!commands` are unaffected.