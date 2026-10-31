# Project: Discord bot

Node.js + discord.js v14 bot with **both slash and prefix commands**, SQLite storage via Node's built-in `node:sqlite`.

## Read first

- `docs/HANDOFF.md` — current state, decisions, pending work. Read this before continuing feature work.
- `docs/adding-commands.md` — command template and CommandContext API.
- `docs/deploy-oracle.md` — Oracle Cloud Always Free deployment.

## Toolchain

Node is **not** installed system-wide. The portable toolchain lives in `.tools/node/`:

```
.tools\node\node.exe
.tools\node\npm.cmd
```

PowerShell script execution is blocked on this machine, so `npm.ps1` fails. Always use the `.bat` wrappers:

| Script | Purpose |
|---|---|
| `start.bat` | Run the bot |
| `dev.bat` | Run with `--watch` (auto-restart on file changes) |
| `deploy.bat` | Register slash commands without starting the bot |
| `package.bat` | Build `dist/bot.zip` for server upload |

## Conventions

- One command per file under `src/commands/<category>/`, default-exporting `{ data, name, execute, ... }`.
- Commands receive a `CommandContext` (`src/lib/context.js`); use `ctx.reply` / `ctx.editReply` so one handler serves slash and prefix.
- Read slash options via `ctx.getString(name)` etc., falling back to `ctx.args` for prefix.
- Log with `createLogger(scope)` from `src/lib/logger.js`, never bare `console.log`.
- Never commit `.env` or `data/`. The token lives only in `.env`.
- Validate changes with `node --check` on every edited file, then a load test with a fake token:
  `DISCORD_TOKEN=fake node src/index.js` (it should load all commands/events, then fail login cleanly).

## Architecture

- `src/index.js` — client, loaders, signal handling, shutdown (closes SQLite).
- `src/lib/loaders.js` — recursive command/event discovery.
- `src/lib/run-command.js` — shared pipeline: guild check, owner check, permissions, cooldown, error handling.
- `src/services/birthday-*.js` — store, role add/remove, daily scheduler.
- Slash commands are re-registered on every startup (guild-scoped when `GUILD_ID` is set).
