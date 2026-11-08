# Handoff — Discord bot

Last updated: 2026-11-08. Read this before continuing work. It exists so a fresh
OpenCode session can resume without the original conversation.

## Status

The bot is **built and running locally** from `start.bat`. Forty-one commands are
implemented: `/ping`, `/help`, `/botinfo`, `/color`, `/colors`, `/birthday`, `/welcome`,
`/clear`, `/top`, `/topchannels`, `/compare`, `/serverstats`, `/summary`, `/watch`,
`/glossary`, `/autoreport`, `/alias`, the profile lookup and moderation packages, the
generated profile cards (`/profile`, `/profile-edit`), and the exile package
(`/exile-setup`, `/exile-role`, `/exile`, `/exile-release`, `/exile-list`, `/exile-log`).

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
first attempt. Current state (boot 10:29 UTC): Node **26.12.1**, `Logged in as
11/10#8627`, `SQLite ready at /home/container/data/bot.db`, scheduler running,
slash commands registered instantly in "𝗧𝗵𝗲 𝗧𝗼𝘄𝗲𝗿 v2". The process now loads
**41 commands / 8 events** (birthday, welcome, clear, colors, color, activity,
profile lookups and cards, nicknames, roles, moderation, summary, watch,
glossary, autoreport, alias, and the six exile commands). The profile cards add `@napi-rs/canvas`, so the panel
must run an install on the next restart before `/profile` can import.

The profile card's status panel also reads **live presence**, so the bot now
requests `GatewayIntentBits.GuildPresences`. **Presence Intent must be enabled in
the Developer Portal** before this build can log in; otherwise Discord answers
`Used disallowed intents` and the process exits.

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
| `/color [primary] [secondary]` | `colour` | Recolor or clear the highest role that only you have |
| `/colors` | `colours`, `palette` | Every color name in Arabic and English |
| `/top [messages\|voice] [all\|7d\|30d] [limit]` | `leaderboard`, `ranking`, `rank` | Member activity ranking |
| `/topchannels [all\|7d\|30d] [limit]` | `channels`, `top-channels` | Text-channel ranking by messages |
| `/compare <@member> <@member> [period]` | `versus`, `vs` | Messages and voice time side by side |
| `/serverstats` | `activity`, `serveractivity`, `sstats` | Server totals, top member and top channel |
| `/lastseen [user]` | `lastactive`, `lastactivity`, `seen`, `last` | Last activity, first message and join date |
| `/backfill [start\|status\|audit\|cancel]` | `importactivity`, `historyimport` | Import older messages into activity stats (owner-only) |
| `/birthday <sub>` | `bd`, `bday`, `birthdays` | 11 subcommands, see below |
| `/welcome <sub>` | `greet` | 8 subcommands, six card styles with editable text |
| `/clear <amount> [user]` | `purge`, `prune` | Bulk-delete recent messages, optionally from one member |
| `/avatar [user]` | `av`, `pfp` | Global + per-server avatar |
| `/profile [user]` | `card`, `profilecard` | Generated PNG card: title, rank, level, points, XP |
| `/banner [user]` | `userbanner` | Profile banner, fetched fresh |
| `/server-avatar [server]` | `serverav`, `servericon`, `sicon` | Server icon; another server only if the bot is in it |
| `/server-banner [server]` | `serverbanner`, `sbanner` | Server banner; another server only if the bot is in it |
| `/mute <@member> [duration] [reason]` | `mute-member` | Muted role, optionally timed |
| `/unmute <@member> [reason]` | — | Remove the Muted role and its timer |
| `/timeout <@member> [duration] [reason]` | `to` | Native timeout; default 10m, max 28d |
| `/untimeout <@member> [reason]` | `untimedout` | End a timeout early |
| `/kick <@member> [reason]` | — | Kick with hierarchy checks |
| `/ban <@user\|id> [duration] [reason]` | — | Permanent or timed ban; an id works for users outside the server |
| `/unban <@user\|id> [reason]` | — | Remove a ban and its timer |
| `/perm grant\|revoke\|list` | `perms`, `commandperm` | Bot-side per-role command grants |
| `/nickname [user] [name]` | `nick` | Self-rename; **Manage Nicknames** for others; empty resets |
| `/role toggle\|add\|remove <@role> [user]` | `roles` | Single role change; `bulk` for every human or bot (**Manage Roles**) |
| `/profile-edit <@member> ...` | `editprofile`, `profile-points` | Title and point edits (Manage Server, grantable) |
| `/summary <sub>` | `summarize`, `report` | AI summary of any channel into the management channel + HTML export |
| `/watch <sub>` | `alert`, `keywords` | Post an alert in a channel when a keyword appears anywhere in the server |
| `/glossary <sub>` | `jargon` | Server terms sent to the summarizer as context |
| `/autoreport <sub>` | `schedule`, `digest` | Scheduled summaries: interval (`6h`) or daily (`09:00`) |
| `/exile <@member> [level] [reason]` | `jail`, `prison` | Give a member an exile role; main or severity 1–10 |
| `/exile-release <@member> [reason]` | `unjail`, `unexile` | Remove the exile role and record the release |
| `/exile-setup <@role> [#except ...]` | — | Deny View Channel everywhere except the listed channels |
| `/exile-role set\|clear\|list` | — | Map main / 1–10 to the roles you created |
| `/exile-list` | `exiles` | Every currently exiled member |
| `/exile-log <#channel\|off>` | — | Audit channel for exile, level change and release |

### Birthday package

Subcommands: `set`, `remove [user]`, `list`, `today`, `next [user]`, `role [role]`,
`channel [#channel]`, `message [text] [gif]`, `send [user]`, `timezone [zone] [user]`.

Behavior that must be preserved:

- `set` validates real dates (Apr 31 rejected; Feb 29 accepted, celebrated Feb 28 in non-leap years).
- `set` accepts a `user` option/target so members with **Manage Server** can register someone else's birthday. Without that permission, targeting anyone but yourself is refused.
- `remove` accepts the same target: yourself by default, someone else with **Manage Server** (added 2026-10-31). It syncs the member afterwards, so a birthday role granted today is revoked immediately.
- `show` is the member's own privacy switch for the profile-card birthday block (`visible:true/false`; prefix `show on/off`). It writes `profiles.show_birthday`, defaults to shown, and can be set before a birthday exists. Staff cannot toggle it for someone else.
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

### Personal role colors

`/color [primary] [secondary]` (prefix `:-color`, alias `colour`; the palette is `/colors` or `:-color list`) recolours the highest role in the member's profile that nobody else has.

- **One or both colors.** Everything is optional: `/color primary:#ff0000` changes only the first color and keeps the current second one, `/color secondary:#00ff00` changes only the second, and two values set the gradient. Prefix is the same, with `-`/`_`/`keep` as a placeholder for the color to keep: `:-color #ff0000`, `:-color - #00ff00`, `:-color #ff0000 #00ff00`. Omitted values are echoed back with a `(kept)` marker.
- **`clear` resets the role.** `/color clear:true`, `/color primary:clear`, or prefix `:-color clear` (`reset`, `none`, `default`, `مسح`, `افتراضي`, `إلغاء`, `إزالة` also work). It sends `setColors({ primaryColor: 0, secondaryColor: null, tertiaryColor: null })`, which is Discord's default colour, and reports "Color cleared". Clear cannot be combined with colors; that is refused with "Pick one". A lone second color on a role with no first color is refused with "First color needed", because Discord needs a primary before a gradient.
- **The role is chosen, not passed as an option.** `findPersonalRole` sorts the member's roles by position, skips `@everyone` and `role.managed` (integration roles cannot be edited), and takes the first role whose member count is exactly 1. No member-permission check: a member can only change a role they alone hold.
- **Member counts are read from Discord, not the cache.** `guild.roles.fetchMemberCounts()` (`GET /guilds/{id}/roles/member-counts`) gives an exact count even when the member cache is cold. `role.members` is the fallback if that endpoint fails; a full `members.fetch()` only runs when the cache is also incomplete.
- **The reachable role wins, with a note.** The command takes the highest personal role that sits *below* the bot's highest role. If the member's top personal role is above the bot, the next editable one is used and the reply names the skipped role, so the colour change is never silently applied to the wrong role. It refuses only when **every** personal role is above the bot.
- **The bot needs Manage Roles** (or Administrator); the role must be strictly below the bot's highest role. `role.managed`, `@everyone`, and the hierarchy are checked before any API call.
- **Colors:** `#rgb`, `#rrggbb`, `0xrrggbb`, bare hex, a small English palette (`red`, `blue`, `purple`, `blurple`, …), and an Arabic palette (`أحمر`, `أخضر`, `أزرق`, `بنفسجي`, …). Names are looked up through `normalizeForMatch`, so hamza variants, diacritics, tatweel and a leading `ال` all match (`أَحْمَر` = `احمر` = `الأحمر`). Arabic-Indic and Persian digits are normalized inside `parseColor`, so `#FF٠٠٠٠` works. `parseColor` is pure and tested.
- **`setColors({ primaryColor, secondaryColor, tertiaryColor: null })`** writes a two-color gradient and clears a holographic third color, so a role that was holographic becomes a normal gradient instead of keeping a stale third color.
- **`/colors` lists everything.** It answers `:-colours` and `:-palette` too, and is a normal command so a server alias can point at it (`:-alias add ألوان colors`). `:-color list` and a bare `:-color` show the same palette.
- **Black is not zero.** Discord reserves color `0` for "no color", so `#000000` would silently clear the role. The parser turns black into `#000001`, the closest visible black; use `clear`/`مسح` to actually remove the color.
- **A 10-second per-member cooldown** protects Discord's role-update limits. Failures give it back: `ctx.fail(...)` marks the run as failed and `run-command.js` deletes the reserved entry, so a typo in a hex code is retryable immediately while a real change still waits. A no-op ("Already set"/"Already clear") also releases it. There is no database table: the role itself is the state.
- **The reply previews the primary color** as the embed color; it is ephemeral on slash and a normal message on prefix. `50013` (permissions/hierarchy), `50035` (gradient not available / invalid form) and `429` (rate limit) get specific messages.

### Moderation package

`mute`, `unmute`, `timeout`, `untimeout`, `kick`, `ban`, `unban`, and `perm`.

- **Durations** live in `src/lib/durations.js`: `40s`, `10m`, `2h`, `7d`, `1w`, or combinations (`1d12h`). Minimum 10s, maximum 365 days. `/timeout` additionally caps at Discord's 28-day limit.
- **Mute is role-based.** `ensureMuteRole` reuses the stored role id, then a role named **Muted**, and only creates one as a last resort. Discord role permissions are additive, so the mute is enforced with channel overwrites (`SendMessages`, `SendMessagesInThreads`, `AddReactions`, `CreatePublicThreads`, `CreatePrivateThreads`, `Speak`) applied to every channel and category once, and to new channels by `channelCreate`.
- **Temporary actions persist.** `moderation_expiries` holds one row per member and kind (`mute`/`ban`); `startModerationScheduler` (wired in `ready.js`) runs `processDueExpiries` every minute, removes the role or the ban, and deletes the row. Failures keep the row so the next tick retries. A short timer can fire up to a minute late.
- **Hierarchy is enforced in the command**, not by run-command: `targetProblem` refuses self, the server owner, the bot itself, bots for mute/timeout, and targets at or above the bot; `actorProblem` refuses targets at or above the invoker unless the invoker owns the server or has Administrator. A member with Administrator is refused by `/mute` because the overwrite would do nothing.
- **`/perm` is a bot-side allowlist, not a Discord permission edit.** `run-command.js` falls back to `hasGrantForMember` only when the Discord permission check fails; the command's own hierarchy checks still run. Rows live in `command_permissions`, `@everyone` is refused, `perm` cannot be granted, and commands without a `permissions` list cannot be granted.
- **Required permissions:** mute/unmute `ManageRoles`; timeout/untimeout `ModerateMembers`; kick `KickMembers`; ban/unban `BanMembers`; perm `ManageGuild`.

### Nicknames and roles

`/nickname` (prefix `nick`) and `/role` (prefix `roles`).

- **Nickname rules mirror Discord's.** Anyone may rename themselves; renaming another member is checked at runtime for **Manage Nicknames**, so the command declares no command-level permission (the `/help` entry stays visible). The bot also needs **Manage Nicknames**, a role above the target, and cannot rename the server owner or itself.
- **Empty means reset.** `/nickname` with no name, or with a reset word (`reset`, `clear`, `remove`, `none`, `-`, `_`, `default`), calls `setNickname(null)`. Values are capped at Discord's 32 characters and the confirmation escapes markdown so a name like `*bold*` cannot reformat the reply.
- **`/role` is staff-only.** It declares `permissions: ['ManageRoles']` and `setDefaultMemberPermissions(ManageRoles)`, including for self-service toggles. It refuses `@everyone`, integration-managed roles, and roles at or above the bot's highest role; it refuses members at or above the bot's highest role.
- **Prefix grammar.** `:-role @Role` toggles on the invoker; `+@Role`/`-@Role`, `+ @Role`/`@Role -`, and the words `add`/`remove`/`toggle` set the action. A member mention or id in front targets that member. `all` means every human member and `bots` means every bot.
- **Role names are searched.** `findRoleMatches` in `lib/resolve.js` normalizes both sides (`normalizeForMatch`: case, Arabic diacritics, alef/ya/ta-marbuta variants) and scores exact name (`3`), starts-with (`2`), contains (`1`). Only the best-scoring roles are returned. One match is used; several are refused with **Ambiguous role** and up to ten candidate names, so `سكان` resolves **سكان البرج** while `رون` lists **رون الاستدعاء**, **رون العش** and **رون العد** and changes nothing. Mentions and ids stay exact.
- **Add/remove are idempotent.** `add` does nothing when the role is already present and `remove` does nothing when it is absent; both reply **Nothing to change** and release the cooldown. `toggle` picks the opposite of the current state.
- **Bulk is bounded.** Members are read from the cache when it is complete, otherwise fetched with `guild.members.fetch()`. Runs process at most `BULK_LIMIT = 500` members, skip those the bot cannot outrank, continue past individual API failures, and report added/removed/unchanged/skipped/failed counts plus the first failure. Slash exposes the same logic through `/role bulk action: target:`.
- **Every change is audited.** `setNickname` and `roles.add`/`roles.remove` receive a `Nickname command: user` / `Role command: user` reason, so Discord's audit log names the invoker.

### Profile lookups

`avatar`, `banner`, `server-avatar`, `server-banner`.

- `avatar` prefers the member's per-server avatar and links both pictures; `banner` forces a user fetch because banners are absent from cached payloads.
- `server-avatar` shows `guild.iconURL()` and `server-banner` shows `guild.bannerURL()`. Both accept a server id or exact name, and can only resolve servers the bot has joined (`client.guilds.fetch`), which is a Discord limitation rather than a choice.

### Profile cards

`/profile` (prefix `:-profile`, aliases `card`/`profilecard`) renders `assets/profile/card.png` at 1868×1200 with `@napi-rs/canvas` and sends only the image. `/profile-edit` (aliases `editprofile`/`profile-points`) writes the numbers and requires **Manage Server**; `/perm grant @Role profile-edit` opens it without that permission.

Behavior that must be preserved:

- **Layout is measured from the template.** Avatar circle at `(108,126)` size 168, name/username at `x=300`, title right-aligned to `x=1750` baseline `198`, six value panels, and the XP track at `x=681 y=980 w=1059 h=49 r=24` in flat `#3c3c42`. `drawXpBar` repaints the track before filling it, so 0% is truly empty and 99% leaves a tiny gap at the right edge. Values are right-aligned to each panel's bottom-right.
- **The lower-left status block sits directly on the artwork.** The template has no panel there, only cloud and rainbow art, so `drawStatusPanel` paints no card: white text carries a soft dark halo and the tiles and pills are light glass, which stays legible over both the grey clouds and the bright streaks while leaving the art visible. Content anchors are fixed: presence/activity header, Messages and Voice tiles, Joined/Account created rows, a centred TOP ROLES pill block, and a bottom birthday block. Roles shrink to two rows when the birthday block is present and three when it is not; the birthday placeholder always closes the block so cards with little data do not end in a void.
- **Presence, activity and roles come from the live member.** Online/idle/DND/offline colour, custom status, and the first non-custom activity (`Playing`, `Streaming`, `Listening to`, `Watching`, `Competing in`). Top roles are sorted by position, exclude `@everyone`, and cap at eight. Without `GuildPresences` every member would look offline, which is why the intent is required.
- **The birthday block is opt-in per member per server.** `profiles.show_birthday` defaults to `1`; `/birthday show visible:false` hides the date, current age and time zone together. The card shows `Hidden by member` (or `Not shared` when no birthday exists) instead of leaking either value. Age is today's age, not `ageTurning`, and a missing birth year simply omits it.
- **Fonts are bundled and registered once.** Inter Medium/SemiBold/ExtraBold for Latin; `Noto Sans Arabic` is selected whenever the nickname matches `/[\u0600-\u06ff…]/`. Canvas shapes Arabic correctly with no HarfBuzz workaround. Long names shrink to a floor and then truncate with `…`, so a renamed member cannot leave the panel.
- **Members who left still render.** The card falls back to the `user` for the name and avatar and reads stored points; `rankFor` returns `null` because the id is not in the current member list. The rank field is left empty in that case.
- **XP:** `xp = floor((nightmare + vex) / 5)`, `level = floor(xp / 100) + 1`, bar progress `xp % 100`. The bar text reads `progress / 100`.
- **Rank:** nightmare + vex among current members. Ties share the rank; a score of zero has no rank; members who left do not push anyone down.
- **Manual points are deltas, never replacements.** Nightmare, vex, good behavior and raw punishment mini points clamp at zero in SQL (`MAX(0, …)`). Good behavior accepts both signs. `/profile-edit` with no options shows the current block instead of changing anything.
- **Punishments are raw mini points.** Seven raw points display as one punishment, and the remainder carries over. Mute/timeout/kick/ban = +1. Exile follows its level: `main` = 0, levels 1–9 = their number, level 10 = ten punishments (70 mini).
- **Only fresh, successful bot actions count.** A failed API call returns before the award. A re-mute while the Muted role is still present, a timeout extension (`member.isCommunicationDisabled()` was true), a ban of someone already banned (`guild.bans.fetch` succeeds before the call), and a level change on an active exile add nothing. A fresh action after release/expiry counts again.
- **Exile history is imported once per guild.** `profile_meta.exile_seeded_at` gates `ensureExileBackfill`, which groups the rows by member and level and adds each level's value (`main` 0, 1–9 = level, 10 = 70). `/exile` calls it **before** `createExile`, so the new row cannot be counted by both the import and the live hook. `/profile` and `/profile-edit` call it too, so old points appear without needing an exile first.
- **The slash reply defers before any fetch or render.** Avatar download, full member fetch for rank and the canvas render can exceed Discord's three-second window; `ctx.defer()` happens first and the error path uses `ctx.fail`.
- **Other bots' points arrive through Discord, not a shared database.** `services/ebot-vex.js` reads one message with a JSON attachment (`vex-balances.json` from E Bot 1, `nightmare-balances.json` from Al-Kabus) in a private channel, trusts only the configured bot id, ignores a `guildId` for another server, caches for 60 seconds and returns `null` on any failure so the card still renders. `profileStats`/`rankFor` take an optional `{ vex, nightmare }` map and add it to every member's stored numbers, which keeps the card and the ranking consistent. Env: `EBOT_VEX_CHANNEL_ID`/`EBOT_BOT_ID` and `NIGHTMARE_CHANNEL_ID` (defaults to the Vex channel)/`NIGHTMARE_BOT_ID`.
- **Storage:** `profiles` (`guild_id`, `user_id`, `title`, `nightmare`, `vex`, `punish_mini`, `good_behavior`, `show_birthday`, `created_at`, `updated_at`) and `profile_meta` (`guild_id`, `exile_seeded_at`, `updated_at`). A missing row reads as zeroes, so rendering never writes. `show_birthday` is added to existing databases by `applyMigrations()`.
- **Title:** capped at `MAX_TITLE_LENGTH = 32`; empty/`reset`/`clear`/`none`/`-` clears it, and the card draws `No Title`.
- **Shipping:** `assets/` is copied by the Dockerfile and included by `scripts/package.ps1`. `package.json` now depends on `@napi-rs/canvas` (prebuilt native binary). The panel must install on restart or the import fails.

### Activity stats

`/top` (prefix `:-top`, aliases `leaderboard`/`ranking`/`rank`), `/topchannels`
(`channels`, `top-channels`), `/compare` (`versus`, `vs`), `/serverstats`
(`activity`, `serveractivity`, `sstats`), `/lastseen` (`lastactive`,
`lastactivity`, `seen`, `last`) and `/backfill` (`importactivity`,
`historyimport`, owner-only).

- **Tracking is live by default.** The first message or voice join creates the
  guild's `activity_meta` row and covers voice. Messages older than that can be
  imported once with `/backfill start` (owner-only); there is no automatic
  backfill, and voice history cannot be recovered at all.
- **Messages:** every human message, commands included. `messageCreate` skips bots
  and system messages and folds thread messages onto the parent text channel.
  Each message updates the all-time member row, the member's day bucket, the
  all-time channel row and the channel's day bucket, inside one transaction.
- **Voice:** a new `voiceStateUpdate` event needs the non-privileged
  `GuildVoiceStates` intent (added in `index.js`). Joins open a row in
  `activity_voice_sessions`; leaves and moves close it and add rounded seconds to
  the member, the old channel and their day buckets. The guild's AFK channel and
  bots are ignored.
- **Restarts:** a five-minute heartbeat advances `last_seen_at`. `ready.js` calls
  `reconcileVoiceSessions` to close stale rows at their last heartbeat (downtime
  is not charged) and reopen sessions for members already in voice. A graceful
  `SIGINT`/`SIGTERM` closes every session before SQLite closes; `index.js` calls
  `stopActivityTracking()`.
- **Backfill:** `/backfill start` reads each text channel backwards from
  `tracking_since` with `before: snowflakeFor(tracking_since)`, so only messages
  the live tracker never saw are imported. Each 100-message page updates the
  member, day and channel totals in one transaction together with the channel's
  `cursor_id`; a restart resumes there. `done` channels are skipped, failed
  channels keep their cursor and are retried on the next start. `activity_meta`
  keeps `messages_since` (moves back with imports) and `voice_since` (stays at the
  live start), and `/backfill status` reads the persisted `activity_backfill`
  rows. Threads are skipped because only the live tracker folds them into their
  parent, and importing a partial set of threads would be misleading.
- **Audit:** `/backfill audit` walks the same channels (newest-first) and writes
  only to `activity_backfill_audit`. Every fetched message is classified as
  system, bot/webhook, live-window human (`>= tracking_since`) or importable human
  (`< tracking_since`). Its `human` total should match `activity_backfill.fetched`
  for the same history; `/backfill status` prints the report as a second embed.
  Cancelling or restarting resumes from the audit cursor, and the import and audit
  refuse to run at the same time.
- **Periods:** `all` reads the totals tables; `7d`/`30d` sum the daily tables from
  `periodStart`, with days keyed by the bot's `TIMEZONE` via `dateKey`. Prefix
  parsing accepts `messages`/`msg`/`رسائل`, `voice`/`vc`/`صوت`, `all`/`كل`,
  `7d`/`week`/`اسبوع`, `30d`/`month`/`شهر`, and a numeric limit (clamped 1–25).
- **Readability:** `/top` and `/topchannels` print a zero-padded code-span rank
  (`01`) and start every row with a left-to-right mark, with another LRM after
  the mention, so an Arabic display name cannot reorder the rank or push the value
  to the wrong side. Footers use the bot's `formatDate` ("05 Nov 2026") because
  Discord does not render `<t:…>` inside a footer; the two rankings also omit the
  embed timestamp so the footer is the only date shown. `/compare` gives each
  member a full-width card headed by their display name (Discord does not render
  mentions in field names) and starts every value with an English label, so an
  Arabic name cannot reorder the numbers. `/lastseen` prints one field per value
  so nothing is squeezed into a narrow inline column.
- **Last seen:** `/lastseen [user]` defaults to the author and reads one member's
  all-time row: last activity, last message, message count, voice time, first
  message and Discord join date. The timestamps are Discord `<t:…>` markup inside
  fields (where it renders), never in the footer.
- **Safety:** the five read commands are guild-only, cost 3–5 seconds of
  cooldown, send `allowedMentions: { parse: [] }` so a leaderboard cannot ping
  anyone, and release the cooldown only on invalid prefix input (`ctx.fail`).
  `/backfill` is guild-only and **owner-only**, costs 10 seconds of cooldown, and
  runs in the background so its interaction never waits for the import.
- **Storage:** `activity_members`, `activity_channels`, `activity_member_days`,
  `activity_channel_days`, `activity_voice_sessions`, `activity_meta` (with
  `tracking_since`, `messages_since`, `voice_since`) and `activity_backfill`
  (`cursor_id`, `oldest_at`, `done`, `fetched`, `error`) plus
  `activity_backfill_audit` (`cursor_id`, `oldest_at`, `done`, `seen`, `bots`,
  `system`, `newer`, `human`, `error`). The richer per-member card now lives in
  the profile package above; activity still stores
  `first_message_at`/`last_message_at`/`last_active_at` for it.

### Exile package

`/exile` (prefix `:-exile`, aliases `jail`/`prison`), `/exile-release`, `/exile-setup`,
`/exile-role`, `/exile-list`, `/exile-log`.

The operator creates eleven roles by hand: one main exile and severity levels 1–10.
`/exile-setup role:@Exile1 except:#exile-1` denies **View Channel** for that role on
every channel and category except the listed ones, so a member holding it sees only
the exceptions. Each role stores its own exception list. `/exile-role set level:1
role:@Exile1` maps a level, and `/exile user:@member level:3` assigns exactly that
one role, removing any other exile role first.

Behavior that must be preserved:

- **One role at a time.** `assignExileRole` removes every other role from
  `allExileRoleIds` (mapped levels plus set-up roles) before adding the chosen one.
  Levels are severity only — there is no timer and no automatic expiry.
- **The fixed all-access role is removed explicitly.** `EXILE_ACCESS_ROLE_ID`
  (`1402366805153939667`) grants View Channel everywhere, so channel overwrites
  cannot contain a member who still holds it. `/exile` removes it before assigning
  the exile role and restores it if the assignment fails; `/exile-release` adds it
  back (active release and stale-role cleanup). An access role the bot cannot manage
  (above its own role, managed by an integration) blocks `/exile` with a refusal
  instead of producing an ineffective exile. If that id is itself configured as an
  exile role, the guard skips the special handling and `assignExileRole` owns it.
- **Schema:** `exile_settings` (log channel), `exile_setups` (a role was configured),
  `exile_roles` (one role per level, unique per guild), `exile_channels` (per-role
  exceptions), `exiles` (active rows plus released rows). A partial unique index
  (`WHERE released_at IS NULL`) allows re-exiling after release but never two active
  rows for one member.
- **`exile_setups` is separate from `exile_channels` on purpose.** A setup with zero
  exceptions stores no channel rows, and "no rows" must not be read as "never set up".
  `/exile` refuses a mapped role that was never configured, because it would hide
  nothing.
- **`/exile-setup` is idempotent.** `reconcileRole` skips an overwrite that already
  matches, reports failed channels instead of claiming success, and runs with a
  concurrency of 3. Re-running replaces that role's exception list; it never stacks.
- **Categories containing an exception are made neutral**, not allowed. A
  channel-level allow already beats the category deny; clearing the bot's own deny is
  enough for the exception to be findable in the sidebar.
- **New channels are hidden automatically.** `channelCreate` calls
  `applyCreationRules`, which applies every set-up role. A new exception channel also
  clears the deny on its parent category. `channelDelete` removes the deleted channel
  from every exception list.
- **Role validation is strict:** `@everyone`, integration-managed roles, roles with
  **Administrator** (it bypasses channel overwrites) and roles at or above the bot's
  highest role are refused. The bot also needs **Manage Roles**.
- **Target validation:** the owner, anyone with **Administrator**, bots, the bot
  itself and members whose highest role is at or above the bot are refused.
- **Release is two-step:** the role must actually be gone before the row is marked
  released. Otherwise `/exile-list` would say a member is free while they are still
  restricted; the command says the role is still applied and keeps the exile active.
- **Leaving the server auto-releases.** `guildMemberRemove` marks the row released
  with "Member left the server"; roles disappear with the member anyway.
- **Audit embeds never throw.** `sendExileLog` checks the channel and its
  View/Send/Embed permissions, logs failures once an hour, and lets the exile succeed
  even when logging is impossible. `allowedMentions` is always `{ parse: [] }`.
- **Every exile command requires Manage Server** (runtime `permissions: ['ManageGuild']`
  and slash `default_member_permissions`). Prefix args never include the command name,
  so `:-exile @member 3 spam` parses member → level → reason.
- Prefix role/channel/member tokens accept mentions, raw ids and names through
  `lib/resolve.js`. Slash `/exile-setup` takes a `role` option plus an `except` string
  of channel mentions/ids, because Discord has no repeatable option.

### Command aliases

`/alias` (prefix `:-alias`, also `:-shortcut`), subcommands `add`, `remove`,
`channel`, `list`.

- An alias maps one **word** to a real command; `مسح 100` runs `clear [100]`. The rest of the message is parsed with the same `parseArgs` as the prefix path, so quotes work.
- **Channel rules** live in `command_aliases.channel_mode` (`allow`/`deny`/NULL) plus `command_alias_channels`. `allow` means only the listed channels; `deny` means everywhere except them; NULL means everywhere. Adding the first channel in a different mode clears the previous list, so the two meanings never mix. Removing the last channel or running `channel clear` resets the mode to NULL.
- **Threads and categories inherit.** `aliasAllowsChannel` tests the message channel, its `parentId` (a thread's parent), the parent's `parentId` (a category), and the cached parent's category. A category rule therefore covers every channel and thread under it.
- Enforcement happens in `runAliasCommand` before the broken/slash-only checks: a restricted alias outside its scope returns false and becomes ordinary chat, matching the existing silent permission behavior. The `:-`-prefixed fallback in `messageCreate` checks the same rule.
- Rows live in `command_aliases` (`guild_id`, normalized `trigger`, `label`, `command`, `channel_mode`). `label` keeps what the admin typed; `trigger` is `normalizeForMatch` (case, Arabic diacritics, alef/ya/ta-marbuta), the same normalization keyword alerts use — it now lives in `lib/text.js`.
- `messageCreate` asks the alias table **only for messages without the prefix**, and `:-مسح 100` reaches the same row through a fallback when the command lookup fails. The prefix always wins.
- **Silent when the member could not run the command.** `canRunAlias` checks `ownerOnly`/`permissions` first and returns false, so the message falls through to normal chat and keyword alerts. Without that, every sentence starting with the trigger would earn a public "Missing permissions" reply.
- **A real command name always wins.** `runAliasCommand` returns false if the first word is a command or a built-in alias, so adding a command later cannot be swallowed by an old shortcut. `add` also refuses those words up front.
- Broken rows are never silent: a deleted command answers "Broken alias" with the exact `alias remove` line, and a `slashOnly` target explains there is no prefix form.
- The trigger must be one word (`\p{L}\p{M}\p{N}_-`, 32 chars). Spaces are refused because everything after the word is the command's arguments; punctuation/emoji are refused because they make matching ambiguous.
- Common words (`من`, `في`, `هذا`, …) are accepted but the save reply warns that every message starting with them will run the command. Alias creation is **Manage Server**; `list` is open.
- Limit 50 per server. Rows are read through a 30-second per-guild cache, invalidated on every write, because every non-prefix message asks for an alias.
- **`/help <command>` shows the server's own aliases.** The detail view merges `command.aliases` (built in) with `command_aliases` rows whose `command` matches, so `مسح → clear` appears next to `purge`/`prune`. `help <custom-alias>` also resolves to the real command, and duplicates of a built-in alias are printed once.

### Report package (summaries, alerts, glossary)

`/summary` (prefix `:-summary`), `/watch` (prefix `:-watch`), `/glossary` (prefix `:-glossary`).

`/summary` subcommands: `run`, `channel`, `export`, `history`.

Behavior that must be preserved:

- **A summary is delivered to the configured management channel, never into the channel it reads.** `/summary channel #room` stores it in `summary_settings`; with nothing set, the report lands where the command was run. This was the user's core complaint about the original bot.
- `run` options: `channel` (read), `hours` (1–168, default 24), `kind` (`general` / `tasks` / `targeted`), `prompt` (required for `targeted`), `private`. Prefix form is order-independent: `:-summary run #general 7d ask when is the next event`, `:-summary #general 24h tasks`, `:-summary 1h general private`.
- Prefix subcommand detection shifts the action off `ctx.args` (`run`, `channel`, `export`, `history`); anything else is a `run`. Prefix args never include the command name.
- **No message archive.** `collectRangeMessages` pages through `channel.messages.fetch` newest-first until `since`, then returns oldest-first. Cap is 3,000 scanned messages; hitting it sets `truncated` and the report footer says to narrow the window.
- Three kinds are prompt emphases in `SUMMARY_KINDS`, not different pipelines. The model always returns one JSON shape; `normalizeSummary` clamps lengths, accepts strings-instead-of-objects, and caps item counts so a drifted reply cannot break rendering.
- Long windows go through map-reduce: `chunkLines` splits the transcript at `AI_MAX_INPUT_CHARS`, each part is summarized, then a merge call deduplicates. The merge call is the only one whose system prompt says "merge".
- Reports are persisted in `summaries` **with the structured body JSON**, so `/summary history` and `/summary export` never call the model again.
- `/summary export [id]` (latest by default) sends a **self-contained HTML file**, not a PDF. Arabic PDFs need font embedding plus shaping; every browser already has both and prints to PDF with `Ctrl/Cmd + P`. The export detects RTL content, escapes HTML, and hides the "print to PDF" hint under `@media print`. Filename: `summary-<channel>-<YYYYMMDD-HHMM>.html`.
- The export button under a report is routed **globally** from `interactionCreate` (`summary:export:<id>`, handled by `handleExportInteraction`), not through a per-message collector. A scheduled report is read hours after it is posted, and a five-minute collector — or any restart — left its button dead, which is exactly what happened to the 07:00 report on 2026-11-02. The payload is stored in SQLite, so the button works at any age; moderators (`ManageMessages`) and the original requester can press it, and a press in DMs is refused politely.
- Reports send `allowedMentions: { parse: [] }`, so a summary can never ping a member or `@everyone`.
- **Names come from `resolveDisplayNames`, not from the raw handle.** Priority is inline `message.member.displayName` → guild member cache → one bounded REST fetch per author (`maxFetches: 30`) → `author.globalName` → `author.username`. History pages often arrive without a `member`, which is why the handle used to leak into reports. `buildSpeakerRoster` then gives the model `- Display Name (handle)` pairs for speakers whose two spellings differ.
- **Names are transliterated when the report is Arabic.** The system prompt forbids raw handles and asks for `It's Emad → عماد` (translation) and `ShinIsekai → شين ايسكاي` (transliteration); the merge prompt forbids one person appearing as `عماد` in one section and `e_a_0` in another.
- **Section labels follow the language of the body**, decided by `isArabicContent` (Arabic share of letters > 30%, the same threshold as the export's direction check). `LABELS.ar` supplies `ملخص عام` / `المواضيع` / `القرارات` / `المهام` / `أسئلة مفتوحة` / `أبرز المقولات` / `233 رسالة`; `LABELS.en` reproduces the previous English strings exactly. `summaryFields(data, labels)` defaults to English so older callers and tests keep their output.
- **Reports are complete but concise.** The system prompt requires every distinct subject/decision/announcement/request/number/link, but each topic is 2–3 sentences and a full day targets 300–500 words; decisions/announcements/questions are one or two sentences. The merge prompt still says merging is not compressing, so map-reduce cannot thin a report. Caps are 12 topics, 15 decisions, 10 announcements, 20 tasks, 10 questions, 6 highlights; `max_tokens` is 4096 (2048 per map part), timeout 180s, because JSON that is cut off mid-answer is worse than a shorter one.
- **The rendered shape is the SummaryBot layout.** Title `نظرة عامة: #channel` (or `Overview: #channel`), sections `📋 مناقشات رئيسية` / `✅ قرارات متخذه` / `📢 إعلانات` / `❓ أسئلة مطروحة` (plus tasks/highlights), each item a bold heading plus a paragraph. Decisions/questions/announcements are stored as `"title — details"` strings so old reports and the arrays stay simple; `splitItem` renders the two parts. Topics carry a `[Jump](url)` built from the `[id:…]` tag the model copies from the transcript; ids not present in the window are dropped rather than linked to the wrong message. The footer is `${scheduleText | last N hours} | N messages analyzed`. Arabic continuations are `الجزء 2/2`.
- **Long reports become multiple messages, never cut.** Discord's 6,000-character limit is the **sum across every embed in one message**, so `renderSummary` still packs fields into embeds of ~5,600 characters and 25 fields, but `reportPayloads` sends each embed as its own message and puts the export button on the last one. Past 8 embeds it sets `truncated` and adds a footer note pointing at the export instead of dropping text silently. Sending the old multi-embed payload as one message was what produced "Could not deliver the summary" on detailed reports.
- **The free key is not the length limit.** Free Gemini quotas are rate limits (per minute/day), not a shorter completion; the length ceiling was our prompt ("2-3 sentences", 8 topics) and a 2,200-token budget. A paid key only helps with volume.
- **`AI_THINKING=off` is the DeepSeek switch.** `deepseek-flash` enables thinking by default (effort high); reasoning tokens are billed as output and can consume the whole `max_tokens` budget before the JSON. Unset sends no `thinking` field, so Gemini is unchanged; `on`/`off`/`enabled`/`disabled` are accepted.
- **Cost is output-dominated.** On `deepseek-flash` off-peak ($0.15/M input, $0.60/M output; peak is double) a ~30k-character day is ~15k input tokens: about $0.003–0.007 per daily report, ~$0.02–0.04/day hourly, ~$0.10–0.20/day at a 15-minute cadence before thinking tokens. Every successful call logs `AI usage (model): X input, Y output tokens`, so the panel log is the spend meter.
- Missing `AI_API_KEY` is a **setup hint reply**, not an exception. Provider errors are translated by `aiProblemHint` (401/403 key, 404 model+URL, 429 rate limit, 5xx retry later). The client retries once on 429/5xx.
- **A 429 shows the provider's own reason.** The hint includes the provider message and `retry-after`, because "rate limiting" alone cannot tell a daily quota from a busy model. The bot cannot bypass Gemini's free-tier limits: the options are waiting for the reset, a smaller window, the lighter `gemini-3.5-flash-lite` model, or a paid key. Scheduled runs now advance `last_run_at` on failure, so the same window is not retried every minute and the quota is not burned twice.
- `chatJson` demands JSON, strips code fences, and re-tries once if the model returns prose — cheaper than failing a 20-message summary.

`/watch` subcommands: `add`, `remove`, `list`, `clear`, `channel`, `test`, `ignore`, `unignore`, `ignored`.

- **The list is shared per server and alerts go to one channel.** `watch_terms` is keyed by `(guild_id, term)` with `created_by`/`created_at` for attribution; the destination is `watch_settings.channel_id`. There is no per-member list and no DM path at all. This replaced the original per-member DM feature after a real report that an admin's keyword never arrived (closed DMs are silent and unverifiable).
- **Ignored channels are a second table, not a term filter.** `watch_ignored_channels` holds channel ids (categories included) with `created_by`/`created_at`, so `/watch ignored` can show who silenced what. A message is skipped when its channel, its parent (a thread's channel) or its grandparent (the category) is on the list; a category therefore covers everything beneath it. The check happens after the terms check and before matching, so ignored traffic costs no regex work and never counts against the burst limit. A deleted channel is dropped by the `channelDelete` event.
- **Choosing the channel needs Manage Server**, every other subcommand needs **Manage Messages**. The slash command also sets `default_member_permissions` to Manage Messages so it is hidden from ordinary members.
- **One alert per message, not one per keyword or per subscriber.** All matching terms are listed in the footer, so `leak` + `secret` in one message is one embed.
- **Bots are skipped, attachments-only messages are skipped, and moderators' own messages are not special** — typing the word is the easiest live test.
- Matching is Unicode whole-word (`(?<![\p{L}\p{N}])term(?![\p{L}\p{N}])`) after `normalizeForMatch`, which strips Arabic diacritics/tatweel and folds alef/ya/ta-marbuta variants. `ass` must not fire on `classic`; `محمد` must match `مُحَمّد`. Duplicate detection uses the same normalization, so both spellings cannot be added twice.
- **The migration rebuilds the old table once.** If `watch_terms` still has `user_id`, `migrateWatchTerms` creates `watch_terms_v2`, copies rows oldest-first while deduplicating on the normalized term (earliest spelling/author wins), drops the old table and renames. `broken` is discarded because it described a DM that no longer exists. The `watch_settings` table is created by the schema.
- **The alert carries the keyword, author, channel, a quote and a `message.url` jump link.** Its `content` is `@everyone` — outside the embed, because Discord does not render mentions inside embeds — with `allowedMentions: { parse: ['everyone'] }`, so every alert notifies the server without allowing role or arbitrary-user pings. The birthday greeting uses the same shape. Without **Mention Everyone** in the alert channel Discord drops the ping silently, so that is logged once per half hour.
- **Rate limit per guild: 2s quiet and 12 per 10 minutes.** A raid cannot flood the alert channel; several words in one message are still one alert.
- `/watch test` posts a real sample in the configured channel, so a wrong channel or a missing **View Channel / Send Messages / Embed Links** permission is visible immediately.
- **Failures are logged once per half hour, never thrown.** A deleted channel, a non-text channel, a rejected send or a missing channel is skipped; chat keeps working and `/watch list` shows the missing-channel warning.
- The guild cache (terms + channel id + ignored channel ids) TTL is 30s; `invalidateWatchCache(guildId)` is called by every mutation, including `/watch channel` and the ignore list.
- The old per-member `listUserTerms`/`markWatchBroken` API is gone. Anything touching watch must use `listWatchTerms`/`findTerm` and `getWatchChannelId`.

`/glossary` subcommands: `add`, `remove`, `list`, `clear`.

- `add` and `remove`/`clear` need **Manage Server**; `list` is open to everyone.
- Terms are stored in `glossary` (max 200, term ≤60, meaning ≤200) and rendered into every summary prompt by `glossaryPrompt`, capped at ~1,800 characters so a runaway glossary cannot crowd out the transcript.
- Prefix syntax is `:-glossary add term | meaning` (split on the first `|`).

`/autoreport` (prefix `:-autoreport`, aliases `schedule`, `digest`) subcommands: `set`, `remove`, `pause`, `resume`, `list`.

- **One schedule per channel**, enforced by `UNIQUE (guild_id, channel_id)`. Saving again updates in place and restarts the countdown (`last_run_at = now`), so "every 6h" begins now instead of inheriting the old clock.
- Cadence is `mode = 'interval'` (`interval_ms`) **or** `mode = 'daily'` (`minute_of_day`), never both. Slash takes `every:` or `time:`; the prefix form decides by shape — a colon means a clock, otherwise a duration; a bare number means hours.
- Intervals are clamped to `MIN_INTERVAL_MS`/`MAX_INTERVAL_MS` (15 minutes – 7 days) in `parseInterval`, so a nonsense value is rejected at the command, not inside the tick.
- **A schedule requires the management channel to exist.** Without one the report would land in the very channel it read, which is the bug `/summary` was built to avoid; `set` refuses and says so.
- The window is `max(last_run_at, now - 7 days) … now`, i.e. time since the last run, capped. An empty window is skipped (no model call, no empty embed).
- The window a scheduled report covers starts at `last_run_at`; `upsertSchedule` sets it to the save time. Re-saving a schedule therefore **restarts the window**, and a first run one minute after `set` summarizes one minute. `/autoreport set` says so in its reply, because "I set 11:43 at 11:42 and got nothing" is otherwise indistinguishable from a scheduler bug.
- `runScheduledReport` touches `last_run_at` before posting and again in the catch, so a failed send or a 429 cannot make the next tick re-read and re-charge the same window. A failed run loses that window's report but waits for the next real cadence instead of hammering the provider every minute.
- Never throws: a deleted channel, missing guild, rate limit or provider outage is logged and skipped, because the tick loop must survive. A `Set` of running schedule ids prevents the boot tick and the interval tick overlapping.
- `startSummaryScheduler` is called from `ready.js` next to the birthday scheduler. It ticks every 60s and runs one **immediately** via `setImmediate`, so a report that came due while the bot was offline still fires (bounded by the 7-day cap).
- `daily` fires once per local day: due when `now >= today's minute_of_day` and `last_run_at <` that instant, which makes the tick idempotent even if it runs several times inside the same minute.
- The manual `/summary run` and the scheduled path share `produceSummary`/`reportPayloads`/`exportPayload` in `services/report-runner.js`, so the two can never drift into different embed shapes.
- **An empty report is never posted.** `produceSummary` returns `data: null` with `reason: 'no-messages'` or `reason: 'empty-summary'` (the model replied with nothing usable, checked by `isEmptySummary`). The scheduler logs the reason and sends nothing; the manual command explains which case it was. Before this, a model that answered with empty arrays produced a message that was only a button — the broken 07:00 report.
- Max 10 schedules per server; mutations need **Manage Server**, `list` is open to everyone.
- `zonedClock` in `lib/dates.js` supplies the wall clock; `dailyInstant` converts a local midnight via `zonedMidnightUnix` so the report fires at the right minute in `Asia/Riyadh`, DST zones included.

## Key decisions

- **Node 26.13 LTS portable** in `.tools/node` (no admin install, no system changes).
- **discord.js 14.27**, ESM (`"type": "module"`).
- **SQLite via `node:sqlite`** — built in, no native build step, works on Alpine ARM. Do not swap in `better-sqlite3` (needs a compiler in the image).
- **Unified CommandContext** so commands are written once for slash + prefix.
- **The typing indicator lives in `run-command.js`, not in each command.** `ctx.typing()` sends `channel.sendTyping()` for prefix contexts and does nothing for slash contexts (which use Discord's native "thinking…" via `ctx.defer()`). It runs after the guild/owner/permission/cooldown gates and before `command.execute`, so a refusal stays silent. Discord drops the indicator after ten seconds, so `run-command.js` re-sends it every 8s while a slow command runs (AI summaries) and clears the timer in `finally`. A failed `sendTyping` is swallowed so it cannot block the command, but it is logged at **warn** (`[context] Could not show the typing indicator: …`) because a silent failure looks exactly like an indicator that never rendered.
- **The running commit is visible from chat.** `/botinfo` shows a **Build** field and the boot log prints `Build <hash> (<date>)`. A zip made by `package.ps1` embeds `build.json` (commit, date, `-dirty` when the tree was not clean) and `lib/build-info.js` reads that first; a git checkout falls back to `git rev-parse`. The marker exists because extracting a zip over an old checkout leaves `.git` pointing at the last *pulled* commit — on 2026-11-08 `/botinfo` reported `dc5d3f2` while the uploaded files were current. A copy with neither reports `unknown` and never fails boot. This also settled why panel restarts appeared to do nothing: the panel identifier (`#10e3e7fb`) is a server id, not a release.
- **Greeting config lives in `guild_settings`** (`birthday_channel_id`, `birthday_message`, `birthday_gif_url`) and deliveries in `birthday_greetings`. New columns are applied with `ALTER TABLE` from `applyMigrations()` in `lib/db.js`, because `CREATE TABLE IF NOT EXISTS` does not upgrade an existing file.
- **Greeting text is a template, not code.** Placeholders are substituted with a regex; unknown placeholders are left literal and surfaced to the admin instead of being silently dropped.
- **Time zones are per member.** The override lives in `birthdays.timezone`; the old guild-wide value is kept as the fallback so servers that already configured it keep working. Resolution order is member → guild default → `TIMEZONE` env.
- **Names resolve over REST, not just the cache.** `displayName()` and the greeting path fetch the user/member when Discord's cache is cold, which is the normal state right after a restart. Without that, `/birthday list` printed raw `<@id>` mentions, which render as a stray `@` inside Arabic names (seen in production on 2026-10-30).
- **`send` is a preview, not a delivery.** It intentionally skips the `birthday_greetings` claim so testing the template cannot cancel the real greeting.
- **Docker** for deployment: `node:24-alpine`, non-root `node` user, `restart: always`, named volume `bot-data` at `/app/data`.
- **Free panel hosting (Wispbyte) over Oracle Cloud.** The operator will not put a card on file, which rules out Oracle and GCP. Wispbyte was chosen over Raven Host on **track record, not specs**: it is three years old with 350k+ users, a public status page and an independent review history, whereas Raven Host launched in 2026, has no third-party reviews, and its own pages disagree on the free tier (45% CPU / 512 MB / 5 GB vs 100% CPU / 1.5 GB / 10 GB). Disk size was not a factor — the whole database is kilobytes.
- **`src/boot.js` is the entry point everywhere.** A version guard must run *before* `src/index.js` is linked, or `node:sqlite` fails with an unhelpful "Cannot find module". `boot.js` imports `node:sqlite` inside a `try`, then dynamically imports the bot. `start.bat`, `dev.bat` and `npm start` all use it; `node src/index.js` still works directly.
- **`node:sqlite` needs Node 22.5+, and the flag until 23.4.** Panels ship older images, so `lib/runtime.js` decides whether to tell the operator to upgrade or to add `--experimental-sqlite`, rather than printing a raw module error.
- **AI is provider-agnostic through one OpenAI-compatible endpoint**, configured entirely in `.env` (`AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `AI_THINKING`, `AI_MAX_INPUT_CHARS`). Default is Google's compatibility layer with `gemini-3.5-flash-lite` (the free-tier model; `gemini-3.6-flash` can answer 429 quota exceeded on a free key); OpenAI, OpenRouter, Groq, DeepSeek and local servers work unchanged. DeepSeek needs `AI_BASE_URL=https://api.deepseek.com`, `AI_MODEL=deepseek-flash` and `AI_THINKING=off`. No provider SDK, no lock-in, and `fetch` is the only dependency.
  **Models expire under you.** Google retired `gemini-2.5-flash` for new keys in 2026 and now answers `404 no longer available to new users`; Google's newest key format is `AQ.…` and the old `AIza…` keys are being shut down. The 404 hint therefore quotes the provider's own message (it names the replacement model) instead of printing a generic "not found".
- **Summaries read Discord history live instead of storing messages.** A local archive would need a full retention policy, disk on a 512 MB panel, and would duplicate data the user did not ask to keep. Discord already has the history; the cost is a `fetch` loop bounded by a 3,000-message cap.
- **The export is HTML, not PDF.** Arabic PDF generation needs an embedded font and shaping (HarfBuzz), which is a native dependency and a whole failure mode; every browser prints HTML to PDF with correct Arabic. The report is delivered as one self-contained file that also opens readably on a phone.
- **Readability beats literal transcripts.** Members are shown by nickname, never by handle, and Latin names are transliterated into Arabic script when the report is Arabic: a report a moderator has to decode is not a report. Section labels are localized from the body text rather than a guild setting, because one server can have Arabic and English channels.
- **Saved reports keep the structured JSON body.** Exporting must not depend on the model still being reachable, and must not produce a *different* report than the one the team approved.
- **Keyword alerts are a server-wide moderation feed, not personal subscriptions.** The first version DMed each subscriber; a real report of a keyword that "never arrived" showed the failure mode is invisible (closed DMs, no retry, no record) and that a per-member list is the wrong shape for a moderation tool. One shared list plus one channel is verifiable with `/watch test`, survives members leaving, and makes "who added this?" answerable via `created_by`. Rate limiting moved from per-user to per-guild because the destination is now shared.
- **Tasks/to-do management was deliberately left out.** The user marked it optional; automatic action-item extraction (`kind:tasks`) already produces the useful part of a to-do list without a second, half-used scheduling feature. Revisit only if asked.
- **Summary depth is a prompt and budget decision, not a model-tier decision.** The first version asked for "2-3 sentences" with only 8 topics and 2,200 output tokens, which read thin; the middle version over-corrected to every distinct point with 4–8 sentences and 700–1,200 words. The current balance keeps the wide caps and the "every point" instruction but shortens the prose to 2–3 sentences per topic and 300–500 words per day, which matches the SummaryBot samples without dropping sections. `max_tokens` stays 4096 with a 180s timeout so JSON is never cut off; no paid key is required for that.
- **Automatic reports are one schedule per channel with two cadences, not two commands.** The user asked for both an interval and a fixed daily time; `mode` in the row carries which one, so `/autoreport set` is the only entry point and there is no ambiguity about which schedule wins. A channel either has a schedule or does not.
- **Scheduled reports reuse the manual pipeline instead of a second implementation.** `produceSummary`/`reportPayloads`/`exportPayload` live in `services/report-runner.js`; the command and the scheduler are thin callers. A scheduled report and a manual one are therefore byte-identical in shape, and a fix to one is a fix to both.
- **The export button is global, not a per-message collector.** A collector ties the button to the process that posted the message: it expires (five minutes) and it dies on restart. A scheduled report is read hours later, so its button was dead on arrival and Discord answered "The application didn't respond in time". Routing `summary:export:<id>` from `interactionCreate` costs one `if`, needs no state, and survives restarts because the report body is already in SQLite.
- **An empty model answer is a skipped report, not a message.** A report with no topics, decisions, tasks, questions or quotes says nothing, and posting it as a heading plus a button reads as a broken bot. `isEmptySummary` turns it into `data: null` with a reason, and the scheduler treats it like an empty window: log, consume the window, send nothing.
- **A schedule needs a management channel before it can be created.** The alternative — delivering into the channel being summarized — is exactly the behavior `/summary` exists to prevent, so the command refuses rather than quietly doing the wrong thing.
- **The scheduler marks the run before posting.** If Discord rejects the message, the window is still consumed; otherwise the next tick would re-read the same messages and bill the model twice for a failure the user may never see.
- **Interval schedules survive downtime; the window is capped at 7 days.** A boot tick runs immediately, so a report that came due while the process was stopped is delivered with a bounded window instead of being silently lost or summarizing a month of history in one call.
- **Command aliases are a word-to-command row, not generated commands.** The operator wanted `مسح 100` instead of `:-clear 100`. Creating a command per alias would mean re-registering slash commands and a command map that mutates at runtime; one row in `command_aliases` plus a first-word lookup in `messageCreate` gives the same result while permissions, cooldowns and errors stay the real command's. A side benefit: `:-مسح 100` also works, because the prefix path falls back to the table when the name is not a command.
- **An alias stays quiet when the member could not run the command.** `canRunAlias` checks the command's own `permissions`/`ownerOnly` before dispatch. Otherwise anyone typing a sentence that starts with the trigger word would get a public "Missing permissions" from the bot, which is worse than the message being ignored. The prefixed form still reports the refusal, because there the member explicitly invoked a command.
- **A real command always beats an alias.** `runAliasCommand` ignores the alias when the first word is a command or built-in alias, so shipping a command named like an old shortcut cannot have its messages swallowed. `add` also refuses command names, built-in aliases, `alias` itself, and multi-word triggers (everything after the trigger is arguments).
- **Alias triggers use the same normalization as keyword alerts.** Case, Arabic diacritics and alef/ya/ta-marbuta variants are folded, so `مُسح` and `مسح` are one alias. The function moved to `lib/text.js` and `watch.js` re-exports it, keeping existing callers unchanged.
- **Exile is roles with per-role exceptions, not timed jails.** The operator asked for one main level plus ten severities and manual release; the number therefore selects a role and nothing else. Adding durations would create a second, invisible state (a timer) that the role list could not explain.
- **One active exile row, enforced by the database.** A partial unique index on `(guild_id, user_id) WHERE released_at IS NULL` makes "two active exiles" impossible even if two commands race; changing a level updates the same row instead of stacking history.
- **A separate `exile_setups` marker.** A role set up with no exceptions stores zero `exile_channels` rows, so the presence of channel rows cannot mean "configured". The marker is what lets `/exile` refuse a mapped-but-unconfigured role instead of silently doing nothing.
- **Administrator is refused on both sides.** A role with Administrator ignores channel overwrites, and a member with Administrator ignores the role too. Accepting either would produce a successful reply with no effect, which is worse than a clear refusal.
- **Categories are neutral, exceptions are allowed.** Discord resolves a channel overwrite above its category. Denying the category while explicitly allowing the exception keeps the exception visible; clearing the bot's own category deny keeps it findable without granting the whole category.
- **Setup is idempotent and reports partial failure.** Hundreds of overwrite edits can hit rate limits or a channel the bot cannot manage. Skipping matching overwrites makes re-running cheap, and listing failed channels lets the admin fix the cause and retry rather than believing a false success.
- **New channels are covered by an event, not a sweep.** `channelCreate` applies every configured role immediately, which closes the obvious loophole (create a channel to talk to the exiled member) without a background job that would need its own schedule and rate-limit budget.
- **Release checks the role, then the record.** Marking the row released while `roles.remove` failed would make `/exile-list` lie. The row is only released after the member no longer holds the role.
- **The all-access role is removed before the exile role is assigned.** Its View
  Channel allow is server-wide, so no channel overwrite can beat it. Treating its
  removal as a prerequisite (and refusing when the bot cannot manage it) prevents a
  "successful" exile that still sees everything; restoring it on a failed assignment
  prevents collateral damage.
- **Leaving the server releases automatically.** Roles vanish with the member, so keeping an active row would leave a permanent ghost in `/exile-list` and in the audit channel. `guildMemberRemove` closes the record with an automatic reason.
- **The profile card is a canvas render, not an embed.** The operator supplied the artwork and asked for the exact layout; a generated PNG is the only way to place values inside its panels. `@napi-rs/canvas` ships prebuilt binaries (no compiler in the Docker image, works on Alpine ARM), and the template plus fonts live in `assets/profile/` so the card is identical on every host.
- **Editing is a separate, grantable command.** `/profile` stays open to everyone, while `/profile-edit` requires **Manage Server**. `/perm grant` already existed for exactly this shape, so an editor role can be delegated without handing out Discord permissions.
- **Punishment dedupe reads live state, not a new table.** Mute role presence, `member.isCommunicationDisabled()`, an active exile row and Discord's idempotent ban endpoint already say whether the punishment is still in force; a second "last punished" table could disagree with reality after a manual change. The pre-ban `bans.fetch` is the one extra call, and it is only needed because the ban endpoint succeeds on an already-banned user.
- **Only exiles can be backfilled.** Mutes, timeouts, kicks and bans have no history table (the bot never stored them), so the one-time import is limited to `exiles`, at each row's level value (`main` 0; levels 1–9 their number; level 10 = 70). `/exile` runs the import first, which is the only ordering that avoids counting a new row twice.
- **Raw punishment points are stored, not the displayed count.** `punish_mini` keeps the remainder, so `13` becomes one punishment now and the next one after two more events, and staff can correct the count without losing history.

## Known issues / caveats

1. **Invite permissions bug (fixed in docs).** The original invite link granted only View Channel, Send Messages, Read Message History, Send Messages in Threads. It was missing **Embed Links**, **Manage Roles** and (for `/clear`) **Manage Messages**. The corrected permissions integer is `275146697792`. Verify the bot has been re-invited.
2. **Docker image is untested locally** — Docker is not installed on this PC. The Node app is tested; the first image build happens on the server.
3. **`.env` currently has** `CLIENT_ID=1558788065873371138`, `PREFIX=:-`, `TIMEZONE=UTC`, `LOG_LEVEL=info`. The token is filled in locally and must never be committed.
4. **The repo is on GitHub.** <https://github.com/minoooooooooooo/tower-bot> — public, `main`. Git + `gh` are installed and authenticated (browser flow, no token in any file). See `deploy-github.md`.
5. **`{age}` is `0` without a birth year.** `/birthday set` accepts a year optionally; members who skip it show `0` wherever the template uses `{age}` (2026-10-31 change, so sentences never read blank).
6. **GIF links must be direct media URLs.** Tenor/Giphy page links do not render as embed images. The `/birthday message` preview shows the result immediately, so a wrong link is caught before a birthday.
7. **Schema upgrades are automatic.** `lib/db.js` runs `ALTER TABLE` for new `guild_settings` columns, `birthdays.timezone` and `profiles.show_birthday` on startup, so an existing `data/bot.db` (or the Docker volume) upgrades in place. Tested against a pre-feature database.
8. **Time zones need a birthday row first.** `/birthday timezone` refuses members who have not run `/birthday set` yet; there is no separate user-settings table.
9. **Panel hosts are not verified yet.** The Wispbyte image's Node version and disk persistence are unknown until the first deploy. `docs/deploy-panel.md` has a restart test for the disk and the boot guard covers the Node version. Raven Host's advertised specs are unconfirmed and inconsistent across its own pages.
10. **Free panel caveat: log in every two weeks** or Wispbyte stops the server. If it stops, birthdays are missed for that window — the scheduler keys everything to the current local date, so missed days are skipped, not backfilled.
11. **`package.bat` used Windows zip separators (fixed 2026-10-30).** The old script used `Compress-Archive`, which stores entries as `src\boot.js`; extracting on Linux created files literally named that, so no `src/` directory existed and the panel reported "Missing Main File". `scripts/package.ps1` now builds entries through `ZipArchive.CreateEntryFromFile` with `/` separators and aborts if any entry contains a backslash. **Any `dist/bot.zip` built before this fix is unusable on Linux hosts.** The stray `src\*` / `docs\*` entries already extracted on Wispbyte cannot be deleted there ("One or more filenames are invalid" — the panel rejects backslashes on delete) and do not need to be: they are ordinary oddly-named files and coexist with a real `src/` directory.
12. **A silent gateway failure used to be invisible (fixed 2026-10-31).** `client.login()` resolves only after Discord's READY packet, so if the host cannot reach `gateway.discord.gg:443` the process logs "Loaded N commands" and then nothing — no error, bot offline, console looks healthy. `src/index.js` now logs `Connecting to the Discord gateway...`, watches shard events (`shardError`, `shardDisconnect`, `shardReconnecting`, `invalidated`), fails an attempt after 60s with the ws state, and **retries forever** with backoff capped at 60s, so a host network blip heals without a manual restart. On the first failure it also runs `src/lib/net-check.js`, which probes DNS → TCP → TLS → HTTPS against Discord and logs one line per layer for support tickets. Invalid token and disallowed intents still exit immediately — no retry fixes those.
   **Real incident:** on Wispbyte node `FREE-EU-RO-15` the container reached GitHub (`git pull`) and npm, but every gateway attempt ended with `ws=CLOSED, ping=NaN` and no shard error, while the same token returned HTTP 200 from another machine. The probe found DNS, TCP and TLS all healthy but `https://discord.com/api/v10/gateway` returning **HTTP 429** — a per-IP rate limit/block on a shared node IP, not a code or credential problem. The probe also reports `retry-after`, `x-ratelimit-scope`, `x-ratelimit-global` and the first 160 characters of the body, because `error code: 1015` (Cloudflare block) and Discord's own `You are being rate limited` need different tickets.
13. **`-IncludeGit` exists for hosts that cannot clone.** `scripts/package.ps1 -IncludeGit` produces `dist/bot-git.zip` (code + `.git/`, ~190 KB). Used on Wispbyte because the install script needs an empty directory and the stray files from #11 refuse to be deleted, so `Reinstall` can never clone. With `.git/` present the egg's `AUTO_UPDATE` command (visible in the console as `Already up to date.`) pulls normally.

## Next steps

- [ ] Confirm the bot was re-invited with permissions `275146697792` (includes **Manage Messages** for `/clear`).
- [ ] Restart `start.bat` and confirm `Loaded 41 command(s)` and `Registered 41 slash command(s)`.
- [ ] Create a `Birthday` role, drag the bot's role above it, run `/birthday role @Birthday`.
- [ ] Set the real fallback time zone: `/birthday timezone default:true <IANA zone>`, then have members run `/birthday timezone <IANA zone>` for their own.
- [ ] Pick a greeting channel with `/birthday channel #birthdays` and confirm it has Send Messages + Embed Links.
- [ ] Preview a custom greeting with `/birthday message text:"..." gif:<direct-url>`; `reset:true` restores the default.
- [ ] Test the template immediately with `/birthday send @member`; confirm the later automatic greeting still posts.
- [ ] Test end to end: `/birthday set <today's month> <today's day>` should grant the role and post one greeting within a second; running it again must not post a second greeting; `/birthday remove` should revoke the role.
- [ ] Test admin flows: `/birthday set user:@member month:... day:...` and `/birthday timezone user:@member zone:...` as an admin, then confirm a non-admin gets "Missing permissions" when targeting someone else.
- [ ] Test moderation: `:-clear 10` in a scratch channel, then `:-clear 5 @member`; confirm older-than-14-days messages are skipped and reported, and that a member without Manage Messages is refused.
- [ ] **Set up exile:** create 11 roles (`Exile Main`, `Exile 1` … `Exile 10`), drag the bot's role above all of them, then run `/exile-setup role:@Exile1 except:#exile-1` for each role (different exceptions per level if wanted).
- [ ] Map every level with `/exile-role set level:<main|1-10> role:@Role`, then `/exile-role list` to confirm all eleven and no `⚠️ not set up`.
- [ ] Test on an alt: `/exile user:@alt` (main) and `/exile user:@alt level:3 reason:test`; the alt should see only that level's exceptions, and their other roles must be untouched. Confirm `/exile-list` and `/exile-log` show the action, and that re-running `/exile` at the same level says "Already exiled".
- [ ] Create a channel and confirm the exiled alt cannot see it; delete an exception channel and confirm `/exile-setup` can be re-run cleanly. Then `/exile-release user:@alt` and confirm the alt sees the server again while the audit row remains.
- [ ] Confirm a role with **Administrator** and a member with **Administrator** are both refused, and that a non-admin gets "Missing permissions" on every exile command.
- [x] Deploy to Wispbyte per `docs/deploy-panel.md` — **done 2026-10-30**, Node 26.12.1, all 5 slash commands registered instantly.
- [ ] First-deploy checks: restart the server and confirm `data/bot.db` survives (the panel guide's restart test). Node version is confirmed good.
- [ ] **Check `TIMEZONE`.** The operator's clock is UTC+3 (console shows 15:48 local / 12:48 UTC). If `.env` still says `Asia/Manila` from the template, greetings fire 5 hours early. Fix with `/birthday timezone default:true zone:<IANA>` or by editing `.env`.
- [ ] Download `data/bot.db` once the first birthdays are saved, and keep it outside the host.
- [ ] Finish the deploy checks before changing anything else: restart test (`data/bot.db` survives), default time zone, birthday role + channel.
- [x] **GitHub auto-deploy is live** (2026-10-31). Code reaches the host by `git pull` on Restart; nothing is uploaded. See `deploy-github.md` for the fields and `recreate-server.md` for how the server was rebuilt.
- [ ] **Fix the two rows dated 31 October 2026** left behind by testing: user `492043876538908692` should be `month:4 day:6 year:2003`, and user `758686823437697044` needs its real date. As stored, both look like birthdays on every 31 October with age 0.
- [ ] **Give user `1271481754779389983` a time zone** (it is null, so it shows the ⚠️ marker) and re-set `758686823437697044`, whose zone is stored lowercase as `asia/amman`.
- [ ] **Take a fresh `bot.db` backup** now that 25 birthdays exist — stop the server first, then download, then verify the count.
- [ ] Try the alias feature after the next restart: `/alias add مسح clear`, then type `مسح 5` in a scratch channel as a moderator (it should delete 5), and as a member without Manage Messages (it should do nothing and the message should stay). `:-alias list` shows it, `:-alias remove مسح` stops it.
- [ ] **Set up the reports feature on the host:** add `AI_API_KEY` (and optionally `AI_MODEL` / `AI_BASE_URL`) to the panel environment, restart, then run `/summary channel channel:#management`.
- [ ] Test `/summary run channel:#general hours:24` (expect the report in the management channel, not in `#general`), then `/summary run channel:#general kind:Action items`, then a targeted one with `prompt:"..."`.
- [ ] Test the export: press **Export as HTML** under a report (or `/summary export`), open the file, check Arabic direction if the channel is Arabic, and print it to PDF once.
- [ ] Test alerts end to end: `/watch channel channel:#mod-log` (or any channel), then `/watch add keyword:<a word you can post>`, post it from an alt or ask a member, and confirm one alert in that channel with a working jump link. Run `/watch test` and confirm the sample appears. Then remove the channel or the bot's Send Messages permission and confirm chat still works and `/watch list` warns.
- [ ] Add a few real terms with `/glossary add` so summaries stop guessing at server vocabulary.
- [ ] Test automatic reports: `/autoreport set channel:#general every:6h`, then `list` to confirm the next run, then force one by waiting or by lowering the interval to `15m` temporarily. Also confirm `/autoreport set channel:#general time:09:00` fires once per day at 09:00 in the server time zone, that a silent channel produces no empty report, and that `pause`/`resume`/`remove` behave.
- [ ] After the next restart, test activity stats: send a few messages, join and leave a voice channel, then run `/serverstats`, `/top`, `/topchannels`, `/compare` and `/lastseen`. Voice tracking uses the non-privileged `GuildVoiceStates` intent, so no portal toggle is needed. On `/top`, press **Next**/**Last** to reach ranks 11–20 and beyond, try `:-top 5` and `/top per_page:25`, and confirm the buttons disappear after 10 minutes.
- [ ] Run `/backfill start` once, watch `/backfill status` until it finishes, then check `/serverstats` shows an older **Messages since** date and the same **Voice since** date, and the message totals stop changing after a second start. Use `/backfill cancel` once mid-run and confirm the next start resumes instead of double-counting; a restart during the import should resume the same way.
- [ ] Run `/backfill audit` after the import and compare its **Human · importable** field with **Imported by backfill**; they should match. Use the **Bots / webhooks** and **Live window · human** fields to explain any gap against Discord search.
- [x] **Last-activity command** (`/lastseen`) — last active, last message, message count, voice time, first message and join date.
- [x] **Profile cards** (`/profile`, `/profile-edit`) — 2026-11-06. Avatar, title, rank, level, nightmare/vex, punishments, good behavior and XP bar on the supplied artwork.
- [x] **Member status panel** (`/profile`) — 2026-11-07. Lower-left panel: presence dot/custom status/activity, message and voice totals, joined/account dates, last seen, top-role pills, and the opt-in birthday/age/time-zone block. `/birthday show` controls the block per member.
- [ ] After the next restart (which must run `npm install` for `@napi-rs/canvas`), run `/profile` and confirm the image arrives with the avatar, name, status panel and an empty rank. Run `/profile-edit @member title:The Keeper nightmare:10 vex:5 punishment:7 behavior:3`, then `/profile @member` and check every panel and the XP bar.
- [ ] Check the status panel on a real member: online/idle/DND/offline dot, custom status, current game, message count, voice time, joined/created dates, last seen, and the top-role pills. Then set a birthday and confirm the date, age and effective time zone. Run `/birthday show visible:false`, re-render, and confirm the block says `Hidden by member`; restore it with `visible:true`.
- [ ] Test the automatic points on an alt: mute (+1), a second mute while still muted (+0), timeout (+1), extending it (+0), unmute, mute again (+1), kick (+1), ban (+1), re-ban (+0). For exile, check `main` (+0), then level 3 (+3), then level 6 (+3 more, total 6), then back to `main` (+0), then level 10 (+64 more, total 70). Confirm `/profile` shows `floor(mini / 7)`.
- [ ] Confirm `/perm grant @Role profile-edit` lets that role edit without **Manage Server**, and that an ordinary member cannot run `/profile-edit`.
- [ ] Confirm the linked-points links at boot: the console prints `E Bot 1 Vex link enabled → channel …` and, when configured, `Al-Kabus nightmare link enabled → channel …` (a missing id prints a disabled warning). Run `/profile` for a member with E Bot 1 Vex and confirm **VEX POINTS** is higher than the staff-entered value and the rank matches. The bot needs **View Channel** + **Read Message History** in that channel. Set `NIGHTMARE_CHANNEL_ID` only if Al-Kabus posts in a different channel, and `NIGHTMARE_BOT_ID` to enable the nightmare link.
- [ ] Run a slow prefix command (`:-profile`, `:-color`, `:-top`) and confirm **bot is typing…** appears while it works and vanishes with the reply. Confirm a command refused by cooldown or permissions shows no typing. Check `/botinfo`'s **Build** field against the commit the host actually pulled (the console shows the `git pull` range); a failing typing call now logs `[context] Could not show the typing indicator: …`.
- [ ] Ask the user for the next batch of commands (games were mentioned).
- [ ] **Enable the Server Members and Presence intents in the Discord Developer Portal** before the next restart. The bot requests `GuildMembers` for welcome cards and `GuildPresences` for the profile status panel; without both portal toggles Discord refuses the login (`Used disallowed intents`) and the bot stays offline until they are enabled.
- [ ] After that restart: `/welcome channel #welcome`, then `/welcome test` to see each of the six styles, then join with an alt (or ask a member to rejoin) to confirm `guildMemberAdd` fires.
- [ ] Decide whether `poster` should use a custom banner. It currently falls back banner → splash → icon, so it works with no setup.
- [ ] Test `/nickname` and `/role` on an alt: rename yourself, reset with an empty name, and confirm a member without **Manage Nicknames** is refused when targeting someone else. As staff, try `:-role @Role` (toggle), `:-role +@Role`, `:-role -@Role`, `:-role @member +@Role`, and `:-role all +@Role` / `:-role bots -@Role`; confirm the bot's highest role sits above the role and the members, and that the bulk summary counts match.

## Verification used so far

- `node --check` across all `src/**/*.js`.
- Load test with a fake token: 41 commands, 8 events, clean login failure.
- Date math: Feb 29 in leap/non-leap years, timezone date shift (`America/New_York`), year rollover.
- Scheduler: role added on birthday, removed the next day, removed immediately when the birthday is deleted.
- Command paths: set (valid/invalid), list, next, today, remove, admin guards, role set/clear, timezone invalid/valid.
- Birthday integration test on a temp DB (132 checks): legacy-schema migration (including `birthdays.timezone`), placeholder rendering and whitespace cleanup, unknown-placeholder detection, message/GIF validation, greeting payload (age, image, mention de-duplication), settings roundtrip, idempotent delivery across repeated passes, atomic claim that blocks a concurrent second pass, release + retry after a failed send, greeting without a role, greeting still sent when the member lookup fails (user-record name fallback), live sync on `set`, prefix and slash parsing, `|` separator, GIF clear/reset, unknown-placeholder warning, channel set/clear with permission guard, non-admin block, admin set-for-others (mention, raw id, slash user), bot rejection, timezone self/admin/default/clear/invalid/no-birthday, per-user greeting and role dates across UTC and Asia/Tokyo, manual `send` (admin-only, no delivery recorded, automatic greeting still fires, `test` alias, missing channel), timezone autocomplete, `list` missing-time-zone flagging (count in the header, per-row marker, custom zone shown, zone equal to the default hidden, warning cleared once every row has one, singular/plural wording, suggestion of the fix command), `list` resolving an uncached name over REST instead of printing a mention, slash subcommand schema, and Feb 29 / time zone date edges.
- Clear integration test on a mocked channel (49 checks): basic 100-message purge, author filter (mention, raw id, either argument order, authorship actually respected), amount-before-mention regression (`:-clear 1 @member` keeps the filter and deletes nothing else), role mention refused without deleting, the command message excluded (alone and inside a filtered scan), partial matches, 100-message batching above 100, empty channel, invalid/missing amounts, bot permission failure, 14-day-old messages skipped, 2,000-message scan cap, slash defer/editReply path, and slash schema. The mock feeds args **without** the command name, matching `messageCreate`.
- `package.bat` produces `dist/bot.zip` with no `node_modules`, `.tools`, `.env`, or `data`, and no entry containing a backslash (the script verifies this and fails loudly).
- Runtime guard test (20 checks): `hasSqliteModule` across Node 18/20/22.4/22.5/24/26 and a malformed version, `needsSqliteFlag` across the 22.5–23.3 boundary, and the three message branches (unsupported version, flag required, unexpected failure).
- Profile/status integration test on a temp DB (126 checks): schema and `show_birthday` migration, points/titles/rank, card PNG dimensions and XP pixels, status-block artwork visibility and presence-dot colours, long/Arabic values, `/profile` slash and prefix replies, `/profile-edit`, birthday visibility defaults, the `/birthday show` slash/prefix toggle, exile level points (per-level backfill, `main` = 0, level 10 = ten punishments, escalation deltas, no subtraction on a downgrade), and linked-bot points (`profileStats`/`rankFor` adding `{ vex, nightmare }` to the stored numbers and the ranking).
- Nickname/role integration test with fake guild/member/role objects (107 checks): `/nickname` slash and prefix self-renames, reset words and an empty name, renaming another member with and without **Manage Nicknames**, mention targeting, the bot renaming itself, the server owner, hierarchy and bot-permission refusals, the 32-character cap, escaped markdown in the confirmation, and API failure messages; `/role` schema and Manage Roles default, toggle on/off, `+`/`-` in every accepted position, the words `add`/`remove`, idempotent add/remove, spaced role names, partial Arabic name search (`سكان` → `سكان البرج`), `@`-prefixed search, starts-with outranking contains, an ambiguous word (`رون`) refused with every candidate listed and nothing changed, a word with no match, member targeting, slash toggle/add/remove, `all`/`bots` bulk add/remove/toggle with skip and failure counts, `@everyone`/managed/higher-role refusals, higher-member refusal, missing bot permission, unknown role, usage text, and no-ping payloads.
- Alias integration test on a temp DB (142 checks): store roundtrip, guild scoping, normalization (diacritics, alef variants, case, upsert in place), remove/clear, table creation; channel rules (allow/deny storage, mode switching clears the old list, removing the last channel resets, clear, category and thread inheritance, cache invalidation, cleanup on remove/clear); dispatch (`مسح 100` → `clear` with `["100"]`, quotes, no arguments, ordinary chat not hijacked, unknown word, missing permission stays silent, owner-only refused for others and allowed for the owner, broken target explained, slash-only target explained, a real command name outranks an alias and the alias returns when that command is removed, allow/deny silence incl. threads and the prefixed form); `messageCreate` for the bare and `:-`-prefixed forms with real commands unaffected; the command surface (add/update/remove/list, channel allow/deny/remove/clear/list, slash options and autocomplete, one-word/punctuation/emoji/length validation, command-name and built-in-alias refusal, unknown command, slash-only and `alias` targets, Manage Server guard on add/remove/channel but not list, prefixed and slashed command input cleaned, common-word warning, the 50-alias limit with updates still allowed, empty list, usage text, broken-row marker, footer count), `help <command>` merging custom aliases with built-ins (no aliases, merged field, resolving a custom alias, other commands excluded, built-in duplicate printed once), and the slash schema.
- `node src/boot.js` with a fake token logs the runtime version, loads 41 commands / 8 events, then fails login cleanly with `TokenInvalid`.
- Welcome integration test on a temp DB (207 checks): style metadata (six keys, modal inputs ≤5, unique keys, label/default limits, known placeholders), settings/text/gif store roundtrips (JSON `enabled`, last style, per-style GIF, per-piece override, clear one/all), style selection (random never repeats, stays inside the enabled set, rotate cycles and wraps, single pins, disabled style falls back, empty list means all), all six payloads (ledger rows/date/count/timestamp, classic thumbnail/fields/shared labels/GIF, poster banner→splash→icon fallback and GIF precedence, story floor, whisper two lines without timestamp, concierge link buttons and the welcome-channel fallback), a GIF on every style, overrides and blank-override fallback, unknown style fallback, ping rules (`allowedMentions` = new member only, title mentions still ping from content), ordinal helper, `guildMemberAdd` (posts once, records the style, skips bots, skips without a channel, failed send keeps `last_style`), and the command surface (channel set/clear + admin guard, mode validation, toggle + last-style guard, list with GIF markers, ephemeral preview, per-style gif set/show/invalid/clear, modal open and prefill, prefix edit redirect, reset one/all, links, overview) including modal submit (save, default-detection, empty clears, unknown placeholder warning, title/footer mention warning, GIF saved per style from any card's modal, invalid GIF rejecting the whole submit, admin guard) and the slash schema. A separate migration script moves a legacy `welcome_settings.gif_url` into `welcome_gifs` on boot.
- Report integration test on a temp DB with a stubbed `fetch` (260 checks): windowed history reads (only the requested range, oldest-first, cap + truncation flag), transcript format and chunking, `normalizeSummary` against drifted model output (strings for objects, unknown keys, overlong text, item caps), single-call vs map-reduce paths (progress callback, merge call content, glossary and focus reaching the prompt), provider failures (retry on 5xx, non-JSON reply, 429 with the provider message and retry-after in `aiProblemHint`, fenced/prose JSON extraction), summary-channel store roundtrip and clear, saved-report roundtrip and guild scoping, glossary upsert/remove/clear and prompt formatting, keyword normalization (diacritics, alef variants, case), whole-word matching for Latin and Arabic, term CRUD and duplicates, channel alert payload (jump link, keywords, an @everyone ping in content outside the embed, quote), skips for bots/empty/unrelated text, quiet-window throttling, missing/deleted-channel handling, HTML export (RTL detection, action items, print stylesheet, safe filename, HTML escaping), and the command surfaces (missing key hint, targeted-without-focus, hours bounds, prefix run posting + storage + export button, management-channel routing, private run, slash run, channel config + Manage Server guard, export file, history list, watch add/list/remove/validation, glossary add/list/guard) plus the five new tables.
- Schedule integration test in the same suite (60 of those 260): `parseInterval` for `6h`/`90m`/`2d`/bare hours and rejection of 5m, 10d and nonsense, `parseClock` for `09:00`/`9:05` and rejection of `24:00`/`09:60`, `formatClock`/`formatInterval` round trips, schedule upsert (cadence stored, countdown starts at creation, one row per channel, second save updates in place and restarts the clock), `isScheduleDue` for interval/paused/daily including "not early" and "not twice in a day" across `Asia/Riyadh`, `nextRunAt` for intervals and daily rollover, a full `runScheduledReport` (delivered to the management channel, export button present, no pings, stored with the scheduler as author, whole window summarized), empty window skipped without sending and reporting no-messages, a model that answers with nothing skipped as empty-summary without posting or storing, missing management channel skipped, and the `/autoreport` surface (prefix interval + daily, in-place switch to daily, missing cadence, targeted without focus, list shows the cadence, pause/resume/remove, Manage Server guard, refusal without a summary channel) plus the slash schema.
- Readability checks in the same suite (35 of those 260): display-name resolution (inline member, guild cache, bounded REST fetch, global-name fallback, username last resort, fetch cap), the transcript printing the name and never the handle, the speaker roster pairing name with handle and skipping identical ones, the roster and transliteration rules reaching the prompt, and Arabic labels across the embed title/fields/footer, the markdown, and the HTML export (sections, message count, Arabic print hint), with English output unchanged. Depth checks in the same suite (16 more): exhaustive/2-3-sentences/length-target wording in the system prompt, merge-not-compress wording, 4096/2048/4096 token budgets, and message packing (a realistic report spans several embeds, each under Discord's 6,000 characters and 25 fields, continuation titles numbered, nothing dropped, one message per embed with the export button only on the last, an oversized report flagged at 8 embeds, every topic keeps its heading, the SummaryBot section names and `title — details` splitting, a Jump link on a topic, and the `Last 24 hours | N messages analyzed` footer). Empty-report and export-button checks in the same suite (14 more): an empty summary renders a placeholder embed instead of nothing, interactionCreate routes summary:export:* and ignores other buttons, a moderator or the scheduler's owner exports while a stranger is refused, a deleted report is explained, a report saved with an empty body is refused instead of exporting a blank file, a DM press is refused, the reply stays ephemeral, and /autoreport set explains a restarted window and a first run only minutes away.
- Watch integration test on a temp DB (142 checks): legacy-schema migration (case/diacritic duplicates merged, earliest spelling/author/timestamp kept, `user_id`/`broken` dropped, `watch_settings` created, `watch_ignored_channels` created), the shared store (guild scope, creator, normalized duplicate, case-insensitive removal, 50-term cap, ignore add/duplicate/list/remove scoping), matcher edges, channel delivery (one alert for several keywords, jump link, quote, an `@everyone` ping in `content` outside the embed with only the everyone mention allowed, ignored channel/category/thread silence with alerts still firing elsewhere, unignore restoring delivery, quiet-window throttle, cache invalidation, bots/empty skipped, missing/non-text/rejected channel swallowed), and the command surface (prefix and slash add/remove/list/clear/channel/test/ignore/unignore/ignored, ignored list with count/creators/deleted marker, category and by-name resolution, foreign-guild refusal, Manage Messages guard, deleted-channel cleanup via the event, empty and truncated list, Manage Messages vs Manage Server guards, unpostable channel, off switch).
- Color integration test with fake guild/member/role objects (224 checks): hex/name parsing (`#rgb`, `#rrggbb`, `0x`, bare, names, invalid, prototype keys), Arabic input (names, hamza/diacritic/tatweel variants, `ال` prefix, feminine forms, Arabic-Indic and Persian digits, unknown words), black being stored as `#000001` instead of clearing, no built-in Arabic command alias (so a guild `لون` alias keeps working), the `/colors` palette (every listed Arabic and English name parses to its listed hex, Arabic title, four groups, slash/prefix/`:-color list`/bare `/color` entry points, cooldown release), highest-exclusive-role selection (shared roles skipped, integration roles skipped, stale-cache counts, no personal role), hierarchy/Manage Roles refusals with the fallback to the highest *editable* personal role (and the skipped role reported), the cache fallback when member counts fail, slash and prefix success payloads, audit reason, `tertiaryColor: null`, unchanged-color short circuit, holographic conversion, API failure reporting, missing/invalid argument replies, partial updates (primary only, secondary only, prefix `-` placeholder, a lone second color refused), clear (`clear` and `مسح` in prefix, in the primary field and in the `clear:true` boolean, with diacritics ignored, no-op "Already clear", colors+clear conflict, too many prefix values), the 10-second cooldown, cooldown release (`ctx.failed`) on every failure path, and `runCommand` regression checks proving a failed or throwing run is retryable immediately while a successful run still answers "Slow down".
- Activity integration test on a temp DB (254 checks): message totals/daily buckets/channel totals, first/last timestamps, all-time and 7d/30d windows, member and channel rankings, per-channel voice seconds, server totals and tracking start, unknown-member/empty-guild zeroes, voice join/leave/move, AFK exclusion, bot exclusion, five-minute heartbeat, crash reconciliation (stale session closed at last heartbeat, still-in-voice session reopened, new voice members picked up, AFK/bots skipped), graceful `finishAllVoiceSessions`, message backfill (page aggregation into member/day/channel totals, first/last min-max, cursor, `done`, error rows, coverage dates), the backfill service end to end on fake pages (threads skipped, snowflake boundary, resume cursor, bot/system/newer filtering, idempotent rerun), the dry-run audit (cumulative per-channel counters, human/bot/system/live split, no activity writes, resume cursor, report embed and `Human · importable` comparison), `/backfill` status/start/audit/cancel/complete and owner-only metadata, formatting helpers (rank badges, footer dates), `/top` (slash/prefix, rank badges, LRM-pinned rows, formatted footer with no raw timestamp, limits, empty state, window-empty hint, invalid option), `/topchannels` (limit, rank badge, deleted-channel label, formatted footer, invalid option), `/compare` (slash/prefix, stacked member cards, display-name headers with no raw field-name mentions, English-led leader line, window, same-member/unknown/missing refusals, quiet window), `/serverstats` (totals, top member/channel, separate message and voice coverage dates, empty state), `/lastseen` (slash/prefix, default author, mention and unknown-member resolution, last activity/message, counts, voice time, first message, join date, empty state), no-ping payloads, command metadata, and the 41-command/8-event loader surface.
- Leaderboard pagination test on a temp DB (61 checks): `topMembers` offset slices (ranks 11–20, a short last page, negative offset ignored) and `countTopMembers` (all-time, 7-day window, guild scoping, unknown guild); the default 10-row first page and its footer, the five-button pager (First/Previous/Page/Next/Last) with correct disabled states, Next/Previous/First/Last navigation including clamping at both ends, the expiry edit that removes the buttons, page-size numbers and `per_page` on both slash and prefix, clamping at 25, a single page omitting the pager, the empty state, and the slash schema (`per_page` 1–25, no `limit`).
- Typing indicator test with a fake channel (13 checks): `messageCreate` sends `sendTyping` before the command executes, an unknown command stays silent, a permission refusal and a cooldown refusal show no typing, a thrown `sendTyping` or a channel without the method still runs the command, a bare alias types too, a prefix `ctx.typing()` call reaches its channel, and a slash context is a no-op. `/botinfo`'s Build field is fed by `lib/build-info.js`, which reads the packaged `build.json` first (tolerating a BOM), falls back to the git checkout, and reports `unknown` when neither exists.
- Linked-points test with a fake Discord channel and a stubbed `fetch` (15 checks): the trusted message's attachment is read, the wrong author and a missing file are refused, negative/NaN amounts are dropped, a second read inside the minute is cached, another guild's `guildId` adds nothing, the nightmare source defaults to the Vex channel, `linkedPoints` returns both maps, network/channel/permission failures return `null` without throwing, and an unconfigured link never touches Discord.
- Moderation integration test with a temp DB and fake guild/member/role/channel objects (131 checks): duration parsing and formatting, mute-role creation (created once, stored, overwrite on every channel, reused, existing role adopted and configured once, new-channel rule), mute (timed, indefinite, prefix parsing, bad duration, self/Administrator/hierarchy refusals, already-muted timer replacement), unmute (role + timer removal, free member), timeout (explicit, default, over 28d, invalid), untimeout, kick (success, missing bot permission, higher target), ban (permanent, timed expiry, owner refusal, non-member by raw id), unban (ban + expiry removal, not banned, raw id), the expiry scheduler (expired mute, expired ban, member who left), permission grants (add/duplicate/list/match/remove, `run-command` bypass and revoke), `/perm grant|revoke|list` guards (self-grant, no-permission command), profile commands (server avatar preference, missing banner, other server by name, unknown server), and the three new tables.
- Exile integration test on a temp DB with fake guild/channel/member objects (227 checks): the five tables and the partial unique index, level normalization (`main`/`M`/`0`/`none`, 1–10, 11 and words refused), level↔role mapping with the one-role-per-level rule, exception replace/add/remove and deleted-channel cleanup, log-channel roundtrip, setup markers (including clearing), active exile create/update/release with re-exile after release; role guards (`@everyone`, managed, Administrator, above the bot, missing Manage Roles) and member guards (owner, bot, Administrator, higher role, self); `reconcileRole` (exception allowed, channels and categories denied, exception category neutralized, threads skipped, idempotent second run, failed channels reported), `applyCreationRules` (new channel hidden, new exception allowed, parent category cleared), `channelCreate`/`channelDelete` events, and the full command surface: setup (prefix and slash, exception replacement, unknown channel, admin-role refusal, Manage Server guard), role set/clear/list (one-level-per-role, unconfigured warning, invalid level, unknown role, slash), exile (prefix level+reason parsing, slash, same-level idempotence, level change removes the old role, level-valued punishment points, the fixed all-access role removed and re-removed, restored after a failed assignment, unmanageable access role refuses the exile, owner/admin/bot/higher refusals, invalid level, unmapped level, unconfigured role, failed role add, audit entries), release (role removal, all-access role restored, record release, stale-role cleanup with access restore, a non-exiled member is left alone, stuck role keeps the record active), list (empty, truncation, active-only, guard), log (set/off, unknown, unwritable, slash), automatic release on `guildMemberRemove`, and every slash schema.

## Useful context

- User's Discord application ID: `1558788065873371138`.
- Correct invite URL:
  `https://discord.com/oauth2/authorize?client_id=1558788065873371138&scope=bot%20applications.commands&permissions=275146697792`
- Data lives in `data/bot.db` locally, `bot-data` volume in Docker, `data/bot.db` on the panel host. Back up by stopping the process and downloading/copying the DB.
- The user prefers concise, direct explanations and wants to be told when something is wrong rather than reassured.
