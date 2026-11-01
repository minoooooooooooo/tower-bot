# Handoff — Discord bot

Last updated: 2026-10-31. Read this before continuing work. It exists so a fresh
OpenCode session can resume without the original conversation.

## Status

The bot is **built and running locally** from `start.bat`. Six commands are
implemented: `/ping`, `/help`, `/botinfo`, `/birthday`, `/welcome`, `/clear`.

**Source is on GitHub:** <https://github.com/minoooooooooooo/tower-bot>
(public, branch `main`). Pushed 2026-10-31 with Git 2.56.0 + `gh` browser auth; no
token lives in the repo or in any local config.

**Deploying is `git push` + panel Restart.** The egg's startup command runs
`git pull` when `.git` exists and `AUTO_UPDATE=1`; verified end to end on
2026-10-31 (`a40e925..1d65c0d  main -> origin/main` printed in the console).

The birthday package now includes automatic greeting messages with a
configurable channel, template placeholders (`{user}`, `{age}`, …) and an
optional GIF, plus per-member time zones and a manual `send` for testing the
template.

**Hosting: Wispbyte free panel, rebuilt 2026-10-31.** The original server died
twice: the node's shared IP was rate limited by Discord (`HTTP 429` on
`discord.com/api/v10/gateway`, gateway closed instantly, `ws=CLOSED`) and its
install script could never clone because stray files from a bad zip were
undeletable. The server was deleted and recreated; the new node logged in on the
first attempt. Current state (boot 10:29 UTC): Node **26.12.1**, 5 commands / 3
events, `Logged in as 11/10#8627`, `SQLite ready at /home/container/data/bot.db`,
scheduler running, 5 slash commands registered instantly in "𝗧𝗵𝗲 𝗧𝗼𝘄𝗲𝗿 v2".

Two consequences worth remembering: the install/reinstall script on this panel
does **not** run (two reinstalls produced an empty directory), so the code is
placed with `dist/bot-git.zip` (code + `.git`) and kept current by the pull; and
the new server's directory is clean, with none of the old junk files.

Oracle Cloud is kept as the card-verification alternative in
[`deploy-oracle.md`](deploy-oracle.md).

## What exists

| Command | Aliases | Notes |
|---|---|---|
| `/ping` | `pong` | WebSocket + roundtrip latency |
| `/help [command]` | `commands`, `h` | Autocomplete, grouped by category |
| `/botinfo` | `info`, `stats` | Uptime, servers, memory, versions |
| `/birthday <sub>` | `bd`, `bday`, `birthdays` | 10 subcommands, see below |
| `/welcome <sub>` | `greet` | 8 subcommands, six card styles with editable text |
| `/clear <amount> [user]` | `purge`, `prune` | Bulk-delete recent messages, optionally from one member |

### Birthday package

Subcommands: `set`, `remove [user]`, `list`, `today`, `next [user]`, `role [role]`,
`channel [#channel]`, `message [text] [gif]`, `send [user]`, `timezone [zone] [user]`.

Behavior that must be preserved:

- `set` validates real dates (Apr 31 rejected; Feb 29 accepted, celebrated Feb 28 in non-leap years).
- `set` accepts a `user` option/target so members with **Manage Server** can register someone else's birthday. Without that permission, targeting anyone but yourself is refused.
- `remove` accepts the same target: yourself by default, someone else with **Manage Server** (added 2026-10-31). It syncs the member afterwards, so a birthday role granted today is revoked immediately.
- `list` is generated live from SQLite and has a button in the reply that switches between **nearest first** and **calendar order** (January → December). Only the member who ran the command can press it, and the button is removed after five minutes. Each row is a fixed-width `08 Nov 2026` date plus the member's **mention** — Discord draws the current display name and role colour, renames need no re-render, and no REST lookup is made. The payload sends `allowedMentions: { parse: [] }`, so listing 60 members pings nobody. The calendar view drops the year because it spans years anyway. Members with no time zone of their own end the row with `⚠️`, and the footer carries the count, the active order, and the server default — that is the admin's checklist for setting 60 members' zones. `today` lists members the same way.
- `role`, `channel`, `message`, and `send` require **Manage Server** at runtime (slash has no per-subcommand default permissions).
- The role is granted on the member's birthday and removed the next day, driven by a scheduler that checks every minute **per member, using that member's own time zone**.
- Assignments are persisted in `birthday_assignments`, so restarts are idempotent. Reconcile runs on startup.
- If the bot is offline for an entire day, that day's roles are not applied retroactively.
- Role setup requires the bot's own role to sit **above** the birthday role, and the bot needs **Manage Roles**.
- `channel` verifies the bot can **Send Messages** and **Embed Links** in the target channel. Setting it greets everyone whose birthday is today immediately; clearing it (no option, `off`, `none`) stops greetings.
- `message` stores a template and an optional GIF URL. Placeholders: `{user}` (mention), `{name}` (display name), `{age}`, `{server}`, `{date}`. Unknown placeholders are left literal and reported back to the admin.
- `send` posts the current template immediately for you or a mentioned/selected member, pinging `@everyone` exactly like a real greeting. It does **not** write to `birthday_greetings`, so the automatic greeting for that day is unaffected.
- `next` renders the countdown as a Discord timestamp (`<t:…:R>`, so it reads "in 5 months" and shows the exact date on hover), with the full date as `<t:…:F>` and the fields stacked vertically instead of side by side. The timestamp is real midnight in the member's zone (`zonedMidnightUnix`), not a UTC stand-in — otherwise the day would be off for anyone east or west of UTC. On the day itself it says "Today" instead of a countdown.
- `{age}` renders as **0** when the member did not save a birth year, so a template sentence never reads blank. The renderer still collapses leftover double spaces.
- Greetings are one embed per member. The message content carries **`@everyone`** outside the embed, so the whole server is notified on a birthday; the member's own mention is added to the content only when the template lacks `{user}`. `allowedMentions` is `{ parse: ['everyone'], users: [id] }`, so the ping works without allowing role or arbitrary-user mentions.
- Discord silently drops an `@everyone` ping when the bot lacks **Mention Everyone** in that channel. The scheduler logs this (throttled to once an hour) and `/birthday send` says so in its confirmation instead of claiming a ping that did not happen.
- Delivery is recorded per member per local day in `birthday_greetings`, so restarts and the once-a-minute scheduler never double-post. A failed send is not recorded and is retried on the next pass.
- Greetings are independent of the role: a channel can be configured with no birthday role, and vice versa. The scheduler only skips a guild when **both** are unset.
- Changing `message` does not rewrite greetings that were already sent; it applies from the next greeting.
- Time zone resolution: `birthdays.timezone` (member override) → `guild_settings.timezone` (server default) → `config.timezone` (`TIMEZONE` env). `/birthday timezone <zone>` sets your own; the `user` option lets an admin set another member's; `default:true` changes the server fallback (admins only).
- A time zone can only be stored once the member has a birthday row; otherwise the command replies "No birthday saved". Clearing the zone sets it back to `NULL`.
- Failed role additions are retried hourly, and repeated warnings (missing permissions, deleted channel) are throttled to once per hour to survive minute-level reconciliation.

### Welcome package

`/welcome` (prefix `:-greet`) posts a card when a member joins, chosen from six styles.

Subcommands: `channel`, `mode`, `toggle`, `list`, `test [style]`, `edit`, `reset [style]`, `links [rules] [general]`.

Behavior that must be preserved:

- Six styles live in `src/services/welcome-styles.js`: `ledger`, `classic`, `poster`, `story`, `whisper`, `concierge`. A style owns its skeleton; only text *pieces* are stored, so editing can never break a layout. `modalInputs(style)` is pieces plus settings, and every style stays at five or fewer because that is Discord's modal limit.
- All six are enabled by default (`welcome_settings.enabled = NULL` means "all"). `mode` is `random` (default), `rotate`, or `single`.
- `random` excludes the previous style, so the same card never appears twice in a row; the choice is remembered in `last_style`.
- Only *edited* pieces are stored in `welcome_texts`. Typing the default back, or emptying a box, deletes the override — the database never accumulates noise.
- `/welcome edit` is slash-only (Discord modals cannot open from a plain message). The modal id is `welcome:edit:<style>`; `interactionCreate` routes modal submits to `command.modal`.
- Editing is admin-only (**Manage Server**). `list` and `test` are open to everyone; `test` is ephemeral so previews never spam the channel.
- A card pings **only the new member**: `allowedMentions = { users: [id], parse: [] }`. The mention goes in `content` when no style text uses `{user}`.
- **Discord does not render mentions in embed titles, footers, or author lines** — only in descriptions and field values. The mention that decides `content` is therefore scanned from descriptions and field values only; a `{user}` left in a title would otherwise suppress the ping and print raw. The Concierge default keeps `{user}` in the description for exactly this reason, and the edit modal warns when `{user}`, `{rules}`, or `{general}` is typed into a title or footer.
- `poster` uses the guild banner, then splash, then icon as its image. `concierge` links `rules` and falls back to the welcome channel for "Say hi", so it always has at least one button.
- Every style has an optional **GIF of its own**, stored in `welcome_gifs` (one row per guild+style). It is edited inside that style's modal as the fifth input (`GIF_INPUT` in `modalInputs`), and `/welcome gif [style] [url]` is the outside-the-form equivalent. A bad URL rejects the whole submit so a card never half-saves. `poster` prefers its GIF over the server banner; every other style shows the GIF under the text.
- Discord allows five modal inputs, so three styles pair two labels into one box split on `|`: Classic `fieldLabels` (`Created | Joined`), Ledger `rowLabels` (`account | next`), Concierge `buttonLabels` (`📜 Rules | 👋 Say hi`). `splitPair` handles them; one value names both.
- The first version stored the Classic GIF in `welcome_settings.gif_url`; `migrateLegacyWelcomeGifs` copies it into `welcome_gifs` and nulls the column on boot, so `/welcome reset` cannot resurrect it.
- Bots are never greeted, and a failed send does not record `last_style`.
- **Requires the Server Members privileged intent** (`GatewayIntentBits.GuildMembers`, enabled in the Developer Portal). `guildMemberAdd` does not fire without it. `members.fetch` (used by birthdays) works without the intent, which is why it was never needed before.

### Clear command

`/clear <amount> [user]` (prefix: `:-clear 100`, `:-clear 50 @someone`, order-independent) bulk-deletes recent messages.

- Requires **Manage Messages** for the member; the bot needs **Manage Messages** and **Read Message History** in the channel.
- Amount is 1–1000. Requests over 100 are split into batches of 100 (Discord's per-request cap).
- Messages older than 14 days are skipped, because Discord refuses to bulk-delete them. The reply reports this.
- With a `user` filter, history is walked newest-first until enough matching messages are found, capped at 2,000 scanned messages. The reply reports partial matches and when the scan cap was hit.
- Slash defers ephemeral first because deletion can exceed the 3-second acknowledgement window; prefix sends the result as a normal channel message.
- The invoking command message is **never deleted**. `collectMessages` receives its id as `excludeId` and skips it, so `:-clear 1` removes the message above the command. A consequence: the bot's own confirmation embed from a previous clear *is* a normal message, so a following `:-clear 1` deletes that instead.
- **Prefix args never contain the command name** — `messageCreate` splits it off (`const [rawName, ...args]`). `clear.js` originally did `ctx.args.slice(1)` and threw away the first argument, which made `:-clear 1` report "Invalid amount" and `:-clear @someone 1` drop the mention and delete the newest messages from anyone. Never slice prefix args; a token is an amount only when it is 1–4 digits, otherwise a member reference.
- A **role** mention (`<@&…>`) is refused with "Unknown member" rather than ignored, so a mis-pinged filter can never quietly clear the whole channel.

## Key decisions

- **Node 26.13 LTS portable** in `.tools/node` (no admin install, no system changes).
- **discord.js 14.27**, ESM (`"type": "module"`).
- **SQLite via `node:sqlite`** — built in, no native build step, works on Alpine ARM. Do not swap in `better-sqlite3` (needs a compiler in the image).
- **Unified CommandContext** so commands are written once for slash + prefix.
- **Greeting config lives in `guild_settings`** (`birthday_channel_id`, `birthday_message`, `birthday_gif_url`) and deliveries in `birthday_greetings`. New columns are applied with `ALTER TABLE` from `applyMigrations()` in `lib/db.js`, because `CREATE TABLE IF NOT EXISTS` does not upgrade an existing file.
- **Greeting text is a template, not code.** Placeholders are substituted with a regex; unknown placeholders are left literal and surfaced to the admin instead of being silently dropped.
- **Time zones are per member.** The override lives in `birthdays.timezone`; the old guild-wide value is kept as the fallback so servers that already configured it keep working. Resolution order is member → guild default → `TIMEZONE` env.
- **Names resolve over REST, not just the cache.** `displayName()` and the greeting path fetch the user/member when Discord's cache is cold, which is the normal state right after a restart. Without that, `/birthday list` printed raw `<@id>` mentions, which render as a stray `@` inside Arabic names (seen in production on 2026-10-30).
- **`send` is a preview, not a delivery.** It intentionally skips the `birthday_greetings` claim so testing the template cannot cancel the real greeting.
- **Docker** for deployment: `node:24-alpine`, non-root `node` user, `restart: always`, named volume `bot-data` at `/app/data`.
- **Free panel hosting (Wispbyte) over Oracle Cloud.** The operator will not put a card on file, which rules out Oracle and GCP. Wispbyte was chosen over Raven Host on **track record, not specs**: it is three years old with 350k+ users, a public status page and an independent review history, whereas Raven Host launched in 2026, has no third-party reviews, and its own pages disagree on the free tier (45% CPU / 512 MB / 5 GB vs 100% CPU / 1.5 GB / 10 GB). Disk size was not a factor — the whole database is kilobytes.
- **`src/boot.js` is the entry point everywhere.** A version guard must run *before* `src/index.js` is linked, or `node:sqlite` fails with an unhelpful "Cannot find module". `boot.js` imports `node:sqlite` inside a `try`, then dynamically imports the bot. `start.bat`, `dev.bat` and `npm start` all use it; `node src/index.js` still works directly.
- **`node:sqlite` needs Node 22.5+, and the flag until 23.4.** Panels ship older images, so `lib/runtime.js` decides whether to tell the operator to upgrade or to add `--experimental-sqlite`, rather than printing a raw module error.

## Known issues / caveats

1. **Invite permissions bug (fixed in docs).** The original invite link granted only View Channel, Send Messages, Read Message History, Send Messages in Threads. It was missing **Embed Links**, **Manage Roles** and (for `/clear`) **Manage Messages**. The corrected permissions integer is `275146697792`. Verify the bot has been re-invited.
2. **Docker image is untested locally** — Docker is not installed on this PC. The Node app is tested; the first image build happens on the server.
3. **`.env` currently has** `CLIENT_ID=1558788065873371138`, `PREFIX=:-`, `TIMEZONE=UTC`, `LOG_LEVEL=info`. The token is filled in locally and must never be committed.
4. **The repo is on GitHub.** <https://github.com/minoooooooooooo/tower-bot> — public, `main`. Git + `gh` are installed and authenticated (browser flow, no token in any file). See `deploy-github.md`.
5. **`{age}` is `0` without a birth year.** `/birthday set` accepts a year optionally; members who skip it show `0` wherever the template uses `{age}` (2026-10-31 change, so sentences never read blank).
6. **GIF links must be direct media URLs.** Tenor/Giphy page links do not render as embed images. The `/birthday message` preview shows the result immediately, so a wrong link is caught before a birthday.
7. **Schema upgrades are automatic.** `lib/db.js` runs `ALTER TABLE` for new `guild_settings` columns and `birthdays.timezone` on startup, so an existing `data/bot.db` (or the Docker volume) upgrades in place. Tested against a pre-feature database.
8. **Time zones need a birthday row first.** `/birthday timezone` refuses members who have not run `/birthday set` yet; there is no separate user-settings table.
9. **Panel hosts are not verified yet.** The Wispbyte image's Node version and disk persistence are unknown until the first deploy. `docs/deploy-panel.md` has a restart test for the disk and the boot guard covers the Node version. Raven Host's advertised specs are unconfirmed and inconsistent across its own pages.
10. **Free panel caveat: log in every two weeks** or Wispbyte stops the server. If it stops, birthdays are missed for that window — the scheduler keys everything to the current local date, so missed days are skipped, not backfilled.
11. **`package.bat` used Windows zip separators (fixed 2026-10-30).** The old script used `Compress-Archive`, which stores entries as `src\boot.js`; extracting on Linux created files literally named that, so no `src/` directory existed and the panel reported "Missing Main File". `scripts/package.ps1` now builds entries through `ZipArchive.CreateEntryFromFile` with `/` separators and aborts if any entry contains a backslash. **Any `dist/bot.zip` built before this fix is unusable on Linux hosts.** The stray `src\*` / `docs\*` entries already extracted on Wispbyte cannot be deleted there ("One or more filenames are invalid" — the panel rejects backslashes on delete) and do not need to be: they are ordinary oddly-named files and coexist with a real `src/` directory.
12. **A silent gateway failure used to be invisible (fixed 2026-10-31).** `client.login()` resolves only after Discord's READY packet, so if the host cannot reach `gateway.discord.gg:443` the process logs "Loaded N commands" and then nothing — no error, bot offline, console looks healthy. `src/index.js` now logs `Connecting to the Discord gateway...`, watches shard events (`shardError`, `shardDisconnect`, `shardReconnecting`, `invalidated`), fails an attempt after 60s with the ws state, and **retries forever** with backoff capped at 60s, so a host network blip heals without a manual restart. On the first failure it also runs `src/lib/net-check.js`, which probes DNS → TCP → TLS → HTTPS against Discord and logs one line per layer for support tickets. Invalid token and disallowed intents still exit immediately — no retry fixes those.
   **Real incident:** on Wispbyte node `FREE-EU-RO-15` the container reached GitHub (`git pull`) and npm, but every gateway attempt ended with `ws=CLOSED, ping=NaN` and no shard error, while the same token returned HTTP 200 from another machine. The probe found DNS, TCP and TLS all healthy but `https://discord.com/api/v10/gateway` returning **HTTP 429** — a per-IP rate limit/block on a shared node IP, not a code or credential problem. The probe also reports `retry-after`, `x-ratelimit-scope`, `x-ratelimit-global` and the first 160 characters of the body, because `error code: 1015` (Cloudflare block) and Discord's own `You are being rate limited` need different tickets.
13. **`-IncludeGit` exists for hosts that cannot clone.** `scripts/package.ps1 -IncludeGit` produces `dist/bot-git.zip` (code + `.git/`, ~190 KB). Used on Wispbyte because the install script needs an empty directory and the stray files from #11 refuse to be deleted, so `Reinstall` can never clone. With `.git/` present the egg's `AUTO_UPDATE` command (visible in the console as `Already up to date.`) pulls normally.

## Next steps

- [ ] Confirm the bot was re-invited with permissions `275146697792` (includes **Manage Messages** for `/clear`).
- [ ] Restart `start.bat` and confirm `Loaded 5 command(s)` and `Registered 5 slash command(s)`.
- [ ] Create a `Birthday` role, drag the bot's role above it, run `/birthday role @Birthday`.
- [ ] Set the real fallback time zone: `/birthday timezone default:true <IANA zone>`, then have members run `/birthday timezone <IANA zone>` for their own.
- [ ] Pick a greeting channel with `/birthday channel #birthdays` and confirm it has Send Messages + Embed Links.
- [ ] Preview a custom greeting with `/birthday message text:"..." gif:<direct-url>`; `reset:true` restores the default.
- [ ] Test the template immediately with `/birthday send @member`; confirm the later automatic greeting still posts.
- [ ] Test end to end: `/birthday set <today's month> <today's day>` should grant the role and post one greeting within a second; running it again must not post a second greeting; `/birthday remove` should revoke the role.
- [ ] Test admin flows: `/birthday set user:@member month:... day:...` and `/birthday timezone user:@member zone:...` as an admin, then confirm a non-admin gets "Missing permissions" when targeting someone else.
- [ ] Test moderation: `:-clear 10` in a scratch channel, then `:-clear 5 @member`; confirm older-than-14-days messages are skipped and reported, and that a member without Manage Messages is refused.
- [x] Deploy to Wispbyte per `docs/deploy-panel.md` — **done 2026-10-30**, Node 26.12.1, all 5 slash commands registered instantly.
- [ ] First-deploy checks: restart the server and confirm `data/bot.db` survives (the panel guide's restart test). Node version is confirmed good.
- [ ] **Check `TIMEZONE`.** The operator's clock is UTC+3 (console shows 15:48 local / 12:48 UTC). If `.env` still says `Asia/Manila` from the template, greetings fire 5 hours early. Fix with `/birthday timezone default:true zone:<IANA>` or by editing `.env`.
- [ ] Download `data/bot.db` once the first birthdays are saved, and keep it outside the host.
- [ ] Finish the deploy checks before changing anything else: restart test (`data/bot.db` survives), default time zone, birthday role + channel.
- [x] **GitHub auto-deploy is live** (2026-10-31). Code reaches the host by `git pull` on Restart; nothing is uploaded. See `deploy-github.md` for the fields and `recreate-server.md` for how the server was rebuilt.
- [ ] **Fix the two rows dated 31 October 2026** left behind by testing: user `492043876538908692` should be `month:4 day:6 year:2003`, and user `758686823437697044` needs its real date. As stored, both look like birthdays on every 31 October with age 0.
- [ ] **Give user `1271481754779389983` a time zone** (it is null, so it shows the ⚠️ marker) and re-set `758686823437697044`, whose zone is stored lowercase as `asia/amman`.
- [ ] **Take a fresh `bot.db` backup** now that 25 birthdays exist — stop the server first, then download, then verify the count.
- [ ] Ask the user for the next batch of commands (games were mentioned).
- [ ] **Enable the Server Members intent in the Discord Developer Portal** before the next restart. The bot now requests `GatewayIntentBits.GuildMembers` for welcome cards; without the portal toggle Discord refuses the login (`Used disallowed intents`) and the bot stays offline until it is enabled.
- [ ] After that restart: `/welcome channel #welcome`, then `/welcome test` to see each of the six styles, then join with an alt (or ask a member to rejoin) to confirm `guildMemberAdd` fires.
- [ ] Decide whether `poster` should use a custom banner. It currently falls back banner → splash → icon, so it works with no setup.

## Verification used so far

- `node --check` across all `src/**/*.js`.
- Load test with a fake token: 5 commands, 3 events, clean login failure.
- Date math: Feb 29 in leap/non-leap years, timezone date shift (`America/New_York`), year rollover.
- Scheduler: role added on birthday, removed the next day, removed immediately when the birthday is deleted.
- Command paths: set (valid/invalid), list, next, today, remove, admin guards, role set/clear, timezone invalid/valid.
- Birthday integration test on a temp DB (132 checks): legacy-schema migration (including `birthdays.timezone`), placeholder rendering and whitespace cleanup, unknown-placeholder detection, message/GIF validation, greeting payload (age, image, mention de-duplication), settings roundtrip, idempotent delivery across repeated passes, atomic claim that blocks a concurrent second pass, release + retry after a failed send, greeting without a role, greeting still sent when the member lookup fails (user-record name fallback), live sync on `set`, prefix and slash parsing, `|` separator, GIF clear/reset, unknown-placeholder warning, channel set/clear with permission guard, non-admin block, admin set-for-others (mention, raw id, slash user), bot rejection, timezone self/admin/default/clear/invalid/no-birthday, per-user greeting and role dates across UTC and Asia/Tokyo, manual `send` (admin-only, no delivery recorded, automatic greeting still fires, `test` alias, missing channel), timezone autocomplete, `list` missing-time-zone flagging (count in the header, per-row marker, custom zone shown, zone equal to the default hidden, warning cleared once every row has one, singular/plural wording, suggestion of the fix command), `list` resolving an uncached name over REST instead of printing a mention, slash subcommand schema, and Feb 29 / time zone date edges.
- Clear integration test on a mocked channel (49 checks): basic 100-message purge, author filter (mention, raw id, either argument order, authorship actually respected), amount-before-mention regression (`:-clear 1 @member` keeps the filter and deletes nothing else), role mention refused without deleting, the command message excluded (alone and inside a filtered scan), partial matches, 100-message batching above 100, empty channel, invalid/missing amounts, bot permission failure, 14-day-old messages skipped, 2,000-message scan cap, slash defer/editReply path, and slash schema. The mock feeds args **without** the command name, matching `messageCreate`.
- `package.bat` produces `dist/bot.zip` with no `node_modules`, `.tools`, `.env`, or `data`, and no entry containing a backslash (the script verifies this and fails loudly).
- Runtime guard test (20 checks): `hasSqliteModule` across Node 18/20/22.4/22.5/24/26 and a malformed version, `needsSqliteFlag` across the 22.5–23.3 boundary, and the three message branches (unsupported version, flag required, unexpected failure).
- `node src/boot.js` with a fake token logs the runtime version, loads 6 commands / 4 events, then fails login cleanly with `TokenInvalid`.
- Welcome integration test on a temp DB (207 checks): style metadata (six keys, modal inputs ≤5, unique keys, label/default limits, known placeholders), settings/text/gif store roundtrips (JSON `enabled`, last style, per-style GIF, per-piece override, clear one/all), style selection (random never repeats, stays inside the enabled set, rotate cycles and wraps, single pins, disabled style falls back, empty list means all), all six payloads (ledger rows/date/count/timestamp, classic thumbnail/fields/shared labels/GIF, poster banner→splash→icon fallback and GIF precedence, story floor, whisper two lines without timestamp, concierge link buttons and the welcome-channel fallback), a GIF on every style, overrides and blank-override fallback, unknown style fallback, ping rules (`allowedMentions` = new member only, title mentions still ping from content), ordinal helper, `guildMemberAdd` (posts once, records the style, skips bots, skips without a channel, failed send keeps `last_style`), and the command surface (channel set/clear + admin guard, mode validation, toggle + last-style guard, list with GIF markers, ephemeral preview, per-style gif set/show/invalid/clear, modal open and prefill, prefix edit redirect, reset one/all, links, overview) including modal submit (save, default-detection, empty clears, unknown placeholder warning, title/footer mention warning, GIF saved per style from any card's modal, invalid GIF rejecting the whole submit, admin guard) and the slash schema. A separate migration script moves a legacy `welcome_settings.gif_url` into `welcome_gifs` on boot.

## Useful context

- User's Discord application ID: `1558788065873371138`.
- Correct invite URL:
  `https://discord.com/oauth2/authorize?client_id=1558788065873371138&scope=bot%20applications.commands&permissions=275146697792`
- Data lives in `data/bot.db` locally, `bot-data` volume in Docker, `data/bot.db` on the panel host. Back up by stopping the process and downloading/copying the DB.
- The user prefers concise, direct explanations and wants to be told when something is wrong rather than reassured.
