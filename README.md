# Discord Bot

A Discord bot with **both slash (`/ping`) and prefix (`:-ping`) commands**, built on Node.js + discord.js v14.

## What's included

- Command and event auto-loading (drop a file in, it works)
- Unified command context, so one handler serves slash and prefix
- Cooldowns, permission checks, owner-only commands, guild-only commands
- Friendly error embeds + full error logging
- Graceful shutdown, unhandled rejection/exception logging
- Slash commands registered automatically on startup (guild scope if `GUILD_ID` is set)
- Portable Node.js in `.tools\node` — nothing installed system-wide

## Setup

### 1. Create the Discord application

1. Open <https://discord.com/developers/applications> and click **New Application**.
2. Go to **Bot** and click **Reset Token** → **Copy**. This is your `DISCORD_TOKEN`.
3. On the same **Bot** page, scroll to **Privileged Gateway Intents** and enable **Message Content Intent** (prefix commands) **and Server Members Intent** (welcome cards — without it the bot refuses to log in after the next update).
4. Go to **General Information** and copy the **Application ID**. This is your `CLIENT_ID`.

### 2. Invite the bot

Open this URL, replacing `YOUR_CLIENT_ID`:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=275146697792
```

That permission value grants: View Channels, Send Messages, Send Messages in Threads, Embed Links, Read Message History, Add Reactions, Use External Emojis, Manage Roles, Manage Messages.

**Manage Roles is only for the birthday feature** and **Manage Messages is only for `/clear`**, and Discord's role hierarchy still prevents the bot from touching any role above its own — so it cannot escalate itself. If you'd rather not grant them up front, invite without them and add them later under Server Settings → Roles.

If you already invited the bot with an older link, re-open the invite URL above and authorize again; Discord updates the bot's permissions in place. Alternatively, grant the missing permissions to the bot's role manually.

### 3. Fill in `.env`

```env
DISCORD_TOKEN=your-token-here
CLIENT_ID=your-application-id
GUILD_ID=your-server-id      # optional but recommended while developing
PREFIX=:-
```

To get `GUILD_ID`: enable **Developer Mode** in Discord settings → Advanced, then right-click your server → **Copy Server ID**.

With `GUILD_ID` set, slash commands appear instantly. Without it, they register globally and can take up to an hour.

### 4. Run it

Double-click **`start.bat`**.

The bot registers its slash commands on startup, so `deploy.bat` is only needed if you want to push commands without starting the bot.

For development with auto-restart on file changes, use **`dev.bat`**.

Both run `src/boot.js`, which checks the Node version before loading the bot and explains what to do if `node:sqlite` is missing. To keep the bot online without your PC, see [Hosting](#hosting).

## Commands

| Command | Aliases | Description |
|---|---|---|
| `/ping` | `:-pong` | WebSocket + roundtrip latency |
| `/help [command]` | `:-commands`, `:-h` | Command list or details for one command |
| `/botinfo` | `:-info`, `:-stats` | Uptime, servers, memory, versions |
| `/birthday <subcommand>` | `:-bd`, `:-bday` | Birthday registry, countdowns, automatic birthday role and greetings |
| `/welcome <subcommand>` | `:-greet` | Welcome cards for new members: six styles, random or rotating, editable text |
| `/clear <amount> [user]` | `:-purge`, `:-prune` | Delete recent messages, optionally only from one member |

## Clearing messages

`/clear amount:100` (prefix: `:-clear 100`) deletes the most recent 100 messages in the channel. Add the optional `user` option to delete only that member's messages:

```
:-clear 100
:-clear 50 @someone
:-clear @someone 50
```

- Requires **Manage Messages** for the member; the bot needs **Manage Messages** and **Read Message History** in the channel.
- Discord only allows bulk deletion of messages younger than 14 days; older ones are skipped and reported.
- When filtering by a member, the bot reads further back through history (up to 2,000 messages) until it finds the requested number.
- Amounts over 100 are split into batches of 100. The maximum is 1,000 per command.

## Birthdays

One command, ten subcommands — each works as a slash command and with the prefix:

| Subcommand | Who | What it does |
|---|---|---|
| `/birthday set <month> <day> [year] [user]` | everyone | Save or update your birthday (admins: set someone else's) |
| `/birthday remove` | everyone | Delete your birthday |
| `/birthday list` | everyone | All birthdays, sorted by next occurrence, flagging members with no time zone |
| `/birthday today` | everyone | Who is celebrating today |
| `/birthday next [user]` | everyone | Countdown for you or someone else |
| `/birthday role [role]` | Manage Server | Choose the role given on birthdays (empty clears it) |
| `/birthday channel [#channel]` | Manage Server | Channel for birthday greetings (empty clears it) |
| `/birthday message [text] [gif]` | Manage Server | Greeting text, placeholders and GIF (empty shows a preview) |
| `/birthday send [user]` | Manage Server | Post the greeting in the configured channel right now |
| `/birthday timezone [zone] [user]` | everyone | Your own time zone (admins: set anyone's; empty resets) |
| `/birthday timezone default:true [zone]` | Manage Server | Server-wide fallback time zone (empty resets) |

Prefix examples:

```
:-birthday set 5 14
:-bd set 2 29 1996
:-bday set @someone 5 14 1996
:-bday next @someone
:-birthday role @Birthday
:-birthday channel #birthdays
:-birthday message Happy birthday, {user}! You are {age}! | https://example.com/cake.gif
:-birthday send @someone
:-birthday timezone Europe/Berlin
:-birthday timezone @someone Asia/Tokyo
:-birthday timezone --default Europe/Berlin
```

### Setting up the birthday role

1. Create a role in **Server Settings → Roles**, e.g. `Birthday`.
2. Drag the bot's own role **above** it — Discord only lets a bot manage roles below its highest role.
3. Give the bot the **Manage Roles** permission.
4. Run `/birthday role @Birthday`.

The scheduler checks once a minute per member, using that member's own time zone. On a new local day it:

- gives the role to everyone whose birthday is today
- removes it from everyone whose assignment is from a previous local day
- posts a birthday greeting if a greeting channel is configured
- retries failed role additions hourly instead of every minute

Assignments are recorded in SQLite, so restarts, crashes, and mid-day reboots are safe — reconciliation is idempotent and re-runs on startup. Feb 29 birthdays are celebrated on Feb 28 in non-leap years.

If the bot is offline for the whole day, that day's roles are not applied retroactively; the next pass corrects the state.

### Time zones

Each member gets their own time zone. A birthday rolls over at midnight **in that member's zone**, so two members on different continents can both be greeted on their actual local date.

`/birthday timezone Europe/Berlin` (prefix: `:-birthday timezone Europe/Berlin`) saves your own zone. Members with **Manage Server** can target someone else with the `user` option (`:-birthday timezone @someone Asia/Tokyo`). Clearing the zone (`/birthday timezone` with no zone, or `:-birthday timezone`) removes your override.

The fallback for members without an override is the server default, set with `/birthday timezone default:true Europe/Berlin` (prefix: `:-birthday timezone --default Europe/Berlin`). If that is unset too, the `TIMEZONE` environment value is used.

A time zone can only be saved after a birthday exists — set the birthday first. `/birthday list` and `/birthday today` evaluate each row in its own zone and mark members whose zone differs from the server default.

### Birthday greetings

1. Pick a channel: `/birthday channel #birthdays` (prefix: `:-birthday channel #birthdays`).
2. Customise the message: `/birthday message text:"🎉 Happy birthday, {user}!" gif:https://media.example.com/cake.gif`.

When a member's birthday starts, the bot posts one embed in that channel, mentioning them. Setting the channel mid-day greets everyone celebrating that day immediately.

| Placeholder | Becomes |
|---|---|
| `{user}` | A mention of the birthday member |
| `{name}` | Their display name |
| `{age}` | The age they turn — blank if no birth year was saved |
| `{server}` | The server name |
| `{date}` | The date, e.g. `May 14` |

`/birthday message` with no options shows the current text, the placeholder list, and a live preview using your own profile. `reset:true` restores the default text and removes the GIF; `gif:none` removes only the GIF. In prefix form, separate the text and GIF with `|`:

```
:-birthday message Happy birthday, {name}! | https://media.example.com/cake.gif
:-birthday message Happy birthday, {user}!
:-birthday message | none
:-birthday message reset
```

The GIF must be a **direct image URL** (ends in `.gif`, `.png`, `.jpg`, or is a `media.tenor.com` / `media.giphy.com` link). A Tenor or Giphy *page* URL will not render — use "Copy Image Address" instead. The preview shows exactly what members will see, so a broken link is obvious before the next birthday.

Greetings are recorded per member per day in SQLite (`birthday_greetings`), so restarts and the once-a-minute scheduler never post duplicates. Changing the message does not edit greetings that were already sent.

To test the current template without waiting for a birthday, an admin can run `/birthday send [user]` (prefix: `:-birthday send @someone`). It posts immediately in the configured channel and is **not** recorded as a delivery, so the real automatic greeting still goes out later that day.

### Data

Birthdays and settings live in SQLite at `data/bot.db` (Node's built-in `node:sqlite`, no native dependencies). In Docker it is stored in the `bot-data` named volume. See [`docs/deploy-oracle.md`](docs/deploy-oracle.md) for backup steps.

## Welcome cards

New members get one of **six card styles**, chosen automatically. All six are enabled by default and the text of every style can be rewritten in Discord — no code changes.

```
:-welcome channel #welcome
:-welcome test                  # preview the next style, only you see it
:-welcome test Poster           # preview one specific style
```

| Style | Look |
|---|---|
| **Ledger** | Aligned date-first rows — the same grammar as `/birthday list` |
| **Classic** | Avatar, mention, two inline fields, optional GIF |
| **Poster** | Full-width server banner with one headline |
| **Story** | Narrative welcome, member count becomes "Floor 48" |
| **Whisper** | Two quiet lines, no fields |
| **Concierge** | Onboarding card with link buttons to rules and chat |

### Choosing the style

| Command | Effect |
|---|---|
| `/welcome mode random` | Random, never the same style twice in a row (default) |
| `/welcome mode rotate` | Walk the enabled styles in order |
| `/welcome mode single style:Story` | Always the same card |
| `/welcome toggle style:Poster` | Turn one style off or on |
| `/welcome list` | Channel, mode, links, and which styles are active |

### Editing the text

`/welcome edit style:Ledger` opens a form with one box per text slot for that style. Change a word, submit, and the card keeps its layout — only strings are stored, never structure. Emptying a box (or typing the default back) restores that piece. `/welcome reset style:Ledger` restores the whole style; `/welcome reset` restores all six.

| Placeholder | Becomes |
|---|---|
| `{user}` | Mention of the new member (the only ping) |
| `{name}` | Their display name |
| `{count}` | Member count after they joined |
| `{ordinal}` | The same number, e.g. `48th` |
| `{server}` | Server name |
| `{joined}` | Join date, e.g. `31 Oct 2026` |
| `{account_age}` | Account age, e.g. `7 years ago` |
| `{rules}` | Rules channel, or `#rules` when unset |
| `{general}` | General channel, or `#general` when unset |

Link the two channels the cards point at with `/welcome links rules:#rules general:#general`. A card pings **only the new member** — never `@everyone` or a role.

### Classic GIF

`/welcome gif url:https://media.example.com/wave.gif` adds a full-width GIF to the **Classic** card (prefix: `:-welcome gif <url>`). `/welcome gif` with no URL shows the current one, and `/welcome gif url:none` removes it. Use a **direct image URL** — a Tenor or Giphy *page* link passes validation but will not render.

**Mentions only render in descriptions and field values.** Discord prints `<@id>` literally inside embed titles and footers, so the default text keeps `{user}` in the description; the editor warns you if you move it into a title or footer. When a card's text has no renderable mention, the bot puts the ping in the message content instead, so the new member is always notified.

**Requires the Server Members privileged intent** (Developer Portal → Bot → Privileged Gateway Intents → Server Members). Without it `guildMemberAdd` never fires, so no card is posted.

## Project layout

```
src/
  boot.js               entry point: runtime check, then loads index.js
  index.js              entry point: client, loaders, shutdown
  deploy-commands.js    standalone slash command registration
  config.js             env parsing + validation
  commands/             one file per command, nested folders OK
    general/
      ping.js
      help.js
      botinfo.js
    community/
      birthday.js       birthday registry + automatic role
    moderation/
      clear.js          bulk message deletion with author filter
  events/
    ready.js            presence, slash registration, scheduler start
    interactionCreate.js
    messageCreate.js    prefix parsing
  handlers/
    command-registry.js slash command payloads + registration
  services/
    birthday-store.js   SQLite queries for birthdays and settings
    birthday-roles.js   role add/remove with permission-safe errors
    birthday-greetings.js greeting rendering, preview, delivery + dedupe
    birthday-scheduler.js per-member reconciliation + scheduler
  lib/
    context.js          unified slash/prefix context
    db.js               SQLite connection + schema
    dates.js            time zone and birthday date math
    embeds.js           embed helpers + colour palette
    loaders.js          recursive command/event loader
    logger.js           levelled logger
    run-command.js      shared execution pipeline
    runtime.js          Node capability checks
```

## Adding a command

See [`docs/adding-commands.md`](docs/adding-commands.md).

## Troubleshooting

**`Used disallowed intents` on startup** — enable **Message Content Intent** in the Developer Portal (Bot → Privileged Gateway Intents), then restart.

**`Invalid token`** — re-copy the token; it resets if you press Reset Token again.

**Slash commands don't appear** — set `GUILD_ID` in `.env` and restart, or run `deploy.bat`. Global commands can take up to an hour.

**`npm.ps1 cannot be loaded`** — this machine blocks PowerShell scripts. Use the `.bat` files instead of `npm run`; they call the portable Node directly.

**Bot offline after reboot** — running on this PC only works while the PC is on and awake. See hosting notes below.

## Hosting

The bot only makes outbound connections, so it needs no open ports and no domain. Any always-on machine works.

**Current choice: a free panel host, Wispbyte.** See [`docs/deploy-panel.md`](docs/deploy-panel.md) — no card required, 512 MB RAM / 1 GB disk, 24/7, with the exact startup command and the two requirements a panel must meet (Node 22.5+, persistent disk).

Also available:

- [`docs/deploy-github.md`](docs/deploy-github.md) — push to GitHub and let the panel pull on restart, so changes never need a manual upload.
- [`docs/deploy-oracle.md`](docs/deploy-oracle.md) — Oracle Cloud Always Free VM, for when you want a real server. Needs a card for identity verification.
- `Dockerfile` — Node 24 Alpine, non-root, production deps only
- `docker-compose.yml` — `restart: always`, log rotation, memory cap, no exposed ports
- `package.bat` / `scripts/package.ps1` — builds `dist/bot.zip` with only the files any host needs (works for panels *and* VMs)

Whichever host you pick, the deployment is the same zip plus six environment variables, so moving takes minutes. Avoid free hosts whose web services sleep on idle — a sleeping process cannot hold a Discord gateway connection.

For reference, a small paid VPS (Hetzner ~€4/mo, DigitalOcean/Vultr $4–6/mo) with the same compose file is the most reliable cheap alternative.
