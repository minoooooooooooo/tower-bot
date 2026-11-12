# Discord Bot

A Discord bot with **both slash (`/ping`) and prefix (`:-ping`) commands**, built on Node.js + discord.js v14.

## What's included

- Command and event auto-loading (drop a file in, it works)
- Unified command context, so one handler serves slash and prefix
- Cooldowns, permission checks, owner-only commands, guild-only commands
- Friendly error embeds + full error logging
- Graceful shutdown, unhandled rejection/exception logging
- Slash commands registered automatically on startup (guild scope if `GUILD_ID` is set)
- Generated PNG profile cards with `@napi-rs/canvas`, shipped with their template and fonts
- Portable Node.js in `.tools\node` — nothing installed system-wide

## Setup

### 1. Create the Discord application

1. Open <https://discord.com/developers/applications> and click **New Application**.
2. Go to **Bot** and click **Reset Token** → **Copy**. This is your `DISCORD_TOKEN`.
3. On the same **Bot** page, scroll to **Privileged Gateway Intents** and enable **Message Content Intent** (prefix commands), **Server Members Intent** (welcome cards) **and Presence Intent** (live status on profile cards). Without all three the bot refuses to log in after the next update.
4. Go to **General Information** and copy the **Application ID**. This is your `CLIENT_ID`.

### 2. Invite the bot

Open this URL, replacing `YOUR_CLIENT_ID`:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=275146697792
```

That permission value grants: View Channels, Send Messages, Send Messages in Threads, Embed Links, Read Message History, Add Reactions, Use External Emojis, Manage Roles, Manage Messages.

**Manage Roles** powers the birthday roles **and the exile roles**; **Manage Messages** powers `/clear`. Discord's role hierarchy still prevents the bot from touching any role above its own — so it cannot escalate itself.

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
| `/botinfo` | `:-info`, `:-stats` | Uptime, servers, memory, versions, and the deployed commit |
| `/color [primary] [secondary]` | `:-colour` | Recolor or clear the highest role that only you have |
| `/colors` | `:-colours`, `:-palette` | List every color name in Arabic and English |
| `/top [messages\|voice] [all\|7d\|30d] [per page]` | `:-leaderboard`, `:-ranking` | Rank members by messages or voice time, 10 per page with paging buttons |
| `/rank [per page]` | `:-rank`, `:-levels`, `:-levelboard`, `:-ranks` | Rank members by level, Vex points and Nightmare points, 10 per page |
| `/topchannels [all\|7d\|30d] [limit]` | `:-channels`, `:-top-channels` | Rank text channels by messages sent |
| `/compare <@member> <@member> [all\|7d\|30d]` | `:-versus`, `:-vs` | Compare two members’ messages and voice time |
| `/serverstats` | `:-activity`, `:-serveractivity`, `:-sstats` | Server activity totals, top member and top channel |
| `/lastseen [user]` | `:-lastactive`, `:-lastactivity`, `:-seen`, `:-last` | When a member was last active, with first message and join date |
| `/backfill [start\|status\|audit\|cancel]` | `:-importactivity`, `:-historyimport` | Import older message history into activity stats (owner-only) |
| `/topemojis [most\|least] [today\|7d\|30d\|all] [per page]` | `:-emojis`, `:-emoji`, `:-emojistats`, `:-topemoji` | Rank this server's custom emojis by in-message and standalone uses, with paging buttons |
| `/emojibackfill [start\|status\|cancel]` | `:-importemojis`, `:-emojihistory` | Import older messages into the emoji stats (owner-only) |
| `/avatar [user]` | `:-av`, `:-pfp` | Show a member's global and per-server avatar |
| `/profile [user]` | `:-card`, `:-profilecard` | Generated profile card: status, role and point panels |
| `/background <subcommand>` | `:-bg`, `:-theme`, `:-wallpaper` | Pick an unlocked card design or upload a custom wallpaper |
| `/banner [user]` | `:-userbanner` | Show a member's profile banner |
| `/server-avatar [server]` | `:-serverav`, `:-servericon`, `:-sicon` | Show a server icon, including another server the bot is in |
| `/server-banner [server]` | `:-serverbanner`, `:-sbanner` | Show a server banner, including another server the bot is in |
| `/birthday <subcommand>` | `:-bd`, `:-bday` | Birthday registry, countdowns, automatic birthday role and greetings |
| `/welcome <subcommand>` | `:-greet` | Welcome cards for new members: six styles, random or rotating, editable text |
| `/ticket <subcommand>` | `:-tickets`, `:-ticket-tool`, `:-support` | Named customizable panels with your own buttons, private channels, claiming, closing and HTML transcripts |
| `/clear <amount> [user]` | `:-purge`, `:-prune` | Delete recent messages, optionally only from one member |
| `/mute <@member> [duration] [reason]` | `:-mute-member` | Add the Muted role, optionally for a limited time |
| `/unmute <@member> [reason]` | — | Remove the Muted role |
| `/timeout <@member> [duration] [reason]` | `:-to` | Discord timeout, default 10m, max 28 days |
| `/untimeout <@member> [reason]` | `:-untimedout` | End a timeout early |
| `/kick <@member> [reason]` | — | Kick a member |
| `/ban <@user\|id> [duration] [reason]` | — | Ban permanently or until the timer ends; an id works when the user is not in the server |
| `/unban <@user\|id> [reason]` | — | Remove a ban |
| `/perm grant\|revoke <@role> <command>` | `:-perms`, `:-commandperm` | Let a role run a command without its Discord permission |
| `/nickname [user] [name]` | `:-nick` | Change your own nickname; **Manage Nicknames** to rename someone else; empty or `reset` clears |
| `/role toggle\|add\|remove <@role> [user]` | `:-roles` | Add, remove or toggle a role for you or a member; `bulk` covers every human or bot (**Manage Roles**) |
| `/profile-edit <@member> ...` | `:-editprofile`, `:-profile-points` | Set the title and add or subtract profile points (Manage Server, grantable) |
| `/exile <@member> [level] [reason]` | `:-jail`, `:-prison` | Give a member an exile role and hide the server from them |
| `/exile-release <@member> [reason]` | `:-unjail`, `:-unexile` | Remove a member's exile role |
| `/exile-setup <@role> [#except ...]` | — | Hide every channel from a role, except the listed ones |
| `/exile-role <set\|clear\|list>` | — | Map each exile level (main, 1–10) to a role |
| `/exile-list` | `:-exiles` | Show every active exile |
| `/exile-log <#channel\|off>` | — | Choose the channel that receives exile records |
| `/summary <subcommand>` | `:-summarize`, `:-report` | AI summary of any channel, delivered to your management channel, exportable as HTML |
| `/watch <subcommand>` | `:-alert`, `:-keywords` | Post an alert in a channel when a watched word appears anywhere in the server |
| `/glossary <subcommand>` | `:-jargon` | Terms and jargon the summarizer should understand |
| `/autoreport <subcommand>` | `:-schedule`, `:-digest` | Post a channel summary automatically, on an interval or at a fixed daily time |
| `/alias <subcommand>` | `:-shortcut`, `:-aliases` | Run a command by typing a word, with no prefix; restrict it to channels |

Slash commands show Discord's native "thinking…" state. Prefix commands show **bot is typing…** in the channel while they fetch, render or write. A command that is refused by the guild check, the owner check, permissions or its cooldown does none of that, so a refusal never looks like work in progress.

## Nicknames and roles

`/nickname [user] [name]` (prefix `:-nick`) renames you. Naming someone else needs **Manage Nicknames**, and the bot needs that permission plus a role above theirs. Leaving the name out — or typing `reset`, `clear`, `remove` or `none` — clears the nickname instead. Discord never lets anyone rename the server owner, and the bot cannot rename itself.

`/role` (prefix `:-roles`) needs **Manage Roles** for every use, including on yourself. Prefix forms:

```
:-role @Role            toggle it on yourself
:-role +@Role           add it if missing
:-role -@Role           remove it if present
:-role @member +@Role   add it to one member
:-role all +@Role       every human member
:-role bots -@Role      every bot
```

`add` and `remove` are no-ops when the member already has, or lacks, the role. `+ @Role` and `@Role +` work too, as do the words `add` and `remove`. Bulk runs skip members at or above the bot's highest role and stop at 500 members per run, reporting added, removed, unchanged, skipped and failed counts.

Role names are searched, not just matched exactly: `:-role سكان` finds **سكان البرج**, ignoring case, Arabic diacritics and alef/ya/ta-marbuta variants. A name that only starts with the typed word beats one that merely contains it, so `run` finds **Rune** before **The Rune**. If the word fits more than one role equally well (`رون` → **رون الاستدعاء**, **رون العش**, **رون العد**), the bot refuses and lists the candidates instead of guessing — type more of the name or mention the role.

## Profile lookups

`/avatar`, `/banner`, `/server-avatar` and `/server-banner` all work on someone else:

- `/avatar user:@member` shows their global picture, and the per-server picture when they have one set (the per-server one is shown first).
- `/banner user:@member` fetches the user so the banner is current; if they have none the reply says so.
- `/server-avatar server:<id or exact name>` and `/server-banner ...` default to the current server. Another server can only be shown if **the bot is already in it** — Discord does not expose private servers to outsiders.
- Prefix forms accept a mention, an id, or a server name: `:-avatar @member`, `:-server-banner 123456789012345678`.

## Profile cards

`/profile` (prefix `:-profile`, aliases `:-card` and `:-profilecard`) renders a 1868×1200 PNG for you or the member you mention. The reply is the image alone — no embed text. Members who have left still render their stored numbers, but their rank is empty. Arabic nicknames are shaped and drawn right to left with the bundled Noto Sans Arabic; the labels on the card stay English.

`/rank` (prefix `:-rank`, `:-levels`, `:-levelboard`, `:-ranks`) is the level leaderboard: member, level, Vex points and Nightmare points, ordered by level and then total points. It pages 10 members at a time with the same buttons as `/top`. Because `/rank` is a real command, `:-rank` reaches it even though `/top` still lists `rank` among its aliases; a command name always beats an alias.

| Field | How it is worked out |
|---|---|
| Title | Set by staff; empty shows **No Title** (max 32 characters) |
| Rank | Nightmare + vex among current members, including linked-bot points. Ties share a rank; 0 points has no rank; members who left are not ranked |
| Level | `floor(xp / 100) + 1` |
| XP bar | `xp % 100`, painted over the template track, from `0 / 100` to `99 / 100` |
| Nightmare, Vex | Staff points, plus the linked-bot balances when those are configured |
| Punishments | `floor(punishment mini points / 7)` |
| Good behavior | Manual points added or subtracted by staff |

XP is `floor((nightmare + vex) / 5)`.

### Backgrounds

A new free design unlocks every five levels and **equips itself automatically** when the member reaches its level. The member can still switch to any unlocked design with `/background set`; the next free unlock replaces a lower automatic pick. The classic artwork is always available.

| Level | Design | Points needed |
|---|---|---|
| 5 | Ember | 2,000 |
| 10 | Verdant | 4,500 |
| 15 | Tide | 7,000 |
| 20 | Amethyst | 9,500 |
| 25 | Rose | 12,000 |
| 30 | Solar | 14,500 |
| 35 | Frost | 17,000 |
| 40 | Void | 19,500 |
| 45 | Prismatic | 22,000 |
| 50 | Celestial + custom wallpaper | 24,500 |

The ladder is data, not code: edit [`assets/profile/backgrounds/backgrounds.json`](assets/profile/backgrounds/backgrounds.json) and push, or create `data/backgrounds.json` on the host (it overrides the bundled file) and restart. Each entry has `id`, `name`, `level`, an optional `price`, an optional `auto`, an optional `artMode`, and a `theme` (`from`, `to`, `accent`). To move Ember to level 3, change its `level` to `3`. To add a purchasable design, give it `"price": 250` and `"auto": false`; it unlocks at its level but never equips itself, and `/background set` refuses it until a purchase system exists.

Each tier now ships with its own picture in `assets/profile/backgrounds/` (`tier-05` … `tier-50`), so the ten designs already look different. The bot draws the panels, labels and XP track over the picture, which keeps their positions fixed. If a tier file is ever missing, the bot falls back to tinting `card.png` with that tier's `theme`.

Artwork files are named `<id>.png`, `.jpg`, `.jpeg` or `.webp`. Two modes:

- `"artMode": "wallpaper"` — supply only the **raw picture**; the bot cover-crops it and draws the glass panels, labels and XP track itself. The bundled tiers use this.
- `"artMode": "template"` — supply the **whole card** with the panels, labels and XP track, exactly where `card.png` has them.

A member's custom upload is always treated as a raw picture. `assets/profile/backgrounds/README.md` has the exact positions and rules.

At **level 50** the Celestial design still equips automatically like every other tier; the member can then upload a custom wallpaper to replace it, and `/background set custom` switches back later. Set a different minimum with `BACKGROUND_CUSTOM_LEVEL=5` in `.env` (restart required). The image is downloaded, checked, cover-cropped to 1868×1200 and re-encoded as a JPEG under `data/profile-backgrounds/<guild>/<user>.jpg` (PNG, JPEG, WebP and GIF are accepted; 10 MB limit, 400×300 minimum). Re-encoding strips metadata and bounds file size. A custom wallpaper stays selectable once it exists, even if points are later corrected downward. `reset` removes the file and returns the card to Classic.

`BACKGROUND_AUTO_EQUIP=0` disables automatic equipping without changing anything else.

```
:-background                 list the ladder and your unlocks
:-background set 15          choose Tide
:-background set Tide        the name works too
:-background custom          attach an image to upload or replace it
:-background reset           back to Classic and delete the upload
```

`/background reset user:@member` (Manage Server) clears someone else's wallpaper. Wallpapers live under `data/`, so include that folder when moving servers or redeploying.

### Linked points from other bots

Two optional links add points the bot does not own, without sharing a database or opening a port. Each source bot keeps **one message with a JSON attachment** in a private channel and edits it when the numbers change:

| Source | File | `.env` |
|---|---|---|
| E Bot 1 | `vex-balances.json` | `EBOT_VEX_CHANNEL_ID`, `EBOT_BOT_ID` |
| Al-Kabus | `nightmare-balances.json` | `NIGHTMARE_CHANNEL_ID` (defaults to the vex channel), `NIGHTMARE_BOT_ID` |

The file looks like `{ "guildId": "…", "balances": { "<userId>": 30 } }`. Only a message written by the configured bot id is trusted, a `guildId` for another server adds nothing, and the result is cached for a minute. Any failure — bot not linked, no file yet, channel not visible — leaves the card with the locally stored numbers. The bot needs **View Channel** and **Read Message History** in that channel. Linked points are added on top of staff points and count toward rank, XP and level, so the card and the ranking agree.

Configure them in `.env`:

```env
EBOT_VEX_CHANNEL_ID=1568630994725249114
EBOT_BOT_ID=1549216732017598564
# NIGHTMARE_CHANNEL_ID=
# NIGHTMARE_BOT_ID=
```

### Status panel

The lower-left of the card is filled from live data, drawn straight onto the artwork — no extra panel, so the clouds and colours stay visible:

| Field | Source |
|---|---|
| Presence | Online / idle / Do Not Disturb / offline dot, custom status and current activity. Requires Discord's **Presence Intent** |
| Messages, Voice time | All-time activity totals from the same store as `/top` |
| Joined, Account created | Discord's member join date and account creation date |
| Last seen | Most recent message or voice activity |
| Top roles | The member's highest roles, without `@everyone` |
| Birthday, age, time zone | The saved birthday, current age when a birth year exists, and the member's effective time zone |

The birthday block is opt-in per member and per server. It is shown by default; hide or restore it with `/birthday show visible:false` / `visible:true` (prefix: `:-birthday show off` / `on`). Hiding it hides the date, age and time zone together. If the block is hidden or no birthday is saved, the panel says so instead of leaving a hole.

### Automatic punishment points

Every punishment the bot actually applies adds raw mini points; a refused or failed action adds nothing. Seven raw points make one displayed punishment, and the remainder carries over.

| Action | Raw points |
|---|---|
| Mute, timeout, kick, ban | +1 each |
| Exile | Follows the level: `main` 0, levels 1–9 their number, level 10 = 70 (ten punishments) |

Repeating a punishment while it is still active counts once: a mute when the Muted role is already there, a timeout while one is running, and a ban for someone already banned add nothing. An exile's points follow the highest level it reached: raising the level adds only the difference, while lowering it or repeating it adds nothing. A fresh punishment after release or expiry counts again.

Existing exile rows are imported once per guild at their own level's value (`main` 0, levels 1–9 their number, level 10 = ten punishments), the first time `/profile`, `/profile-edit` or `/exile` runs. Mutes, timeouts, kicks and bans have no history table, so they start at zero.

### Editing

`/profile-edit` requires **Manage Server** and can be opened to a role with `/perm grant @Role profile-edit`.

```text
/profile-edit user:@member title:The Keeper nightmare:10 vex:-5 punishment:7 behavior:3
:-profile-edit @member title The Keeper
:-profile-edit @member nightmare +10 vex -5 punishment +7 behavior -2
```

Values are deltas, not replacements. Every stored field is clamped at zero, so a correction can empty a field but never push it negative. The `punishment` option is raw mini points (`7` is one displayed punishment). `title:reset` (or `:-profile-edit @member title reset`) clears the title.

## Activity stats

The bot counts **messages** and **voice time** per member and per channel, then answers `/top`, `/topchannels`, `/compare`, `/serverstats` and `/lastseen`.

- **Tracking starts when the bot first sees activity.** `/serverstats` shows separate message and voice start dates. Voice history cannot be recovered, so the voice date never moves earlier.
- **Message history can be imported once.** Run `/backfill start` (owner-only) to walk every text channel backwards from the live start. It runs in the background, saves a cursor after every 100-message page, survives restarts, and never counts a message twice. `/backfill status` shows progress and `/backfill cancel` stops cleanly. Threads and voice history are not backfilled.
- **`/backfill audit`** is a dry run for the same history: it counts human, bot/webhook, system and live-window messages without changing any totals, so you can verify why the imported count differs from Discord search.
- **Counted:** every human message (commands included) and time spent in a voice channel. Bots are ignored, and the server's **AFK channel** never counts.
- **Threads** count toward their parent text channel, so a busy thread does not hide the channel that spawned it.
- **Windows** are `all` (default), `7d` and `30d`. Days are bucketed in the bot's `TIMEZONE`. `:-top` also accepts the shorter words `week` and `month`, and Arabic `رسائل`/`صوت`/`اسبوع`/`شهر`.
- **Voice sessions survive restarts.** A graceful shutdown closes them; after a crash they are closed at the last five-minute heartbeat, so at most five minutes can be overcounted. Downtime while the bot is offline is not counted.
- The numbers live only in the server's own SQLite file (`data/bot.db`). There is no external service.
- `/top` shows 10 members per page and pages through the rest with **First / Previous / Next / Last** buttons, so ranks 11–20, 21–30 and beyond are reachable. Choose the page size with `per_page` on slash or a number in prefix (`:-top 25`), from 1 to 25. `/topchannels` shows the top 10 (max 25); `/compare` shows messages, voice time and last activity side by side.
- **Readable even with Arabic names.** Rankings use a fixed `01` rank column and left-to-right pins, so a display name cannot reorder the rows; the footer dates the tracking start instead of printing a raw timestamp.
- **`/lastseen [user]`** shows one member's last activity, last message, message count, voice time, first message and join date. It defaults to you when no member is given.

## Emoji stats

`/topemojis` (prefix `:-topemojis`, aliases `emojis`, `emoji`, `emojistats`, `topemoji`) ranks the server's **custom** emojis, the way `/top` ranks members. Unicode emojis are not counted: custom emojis have a stable id, so the ranking survives renames.

- **Two kinds of use.** A message that contains nothing but custom-emoji tokens (and whitespace) counts as **standalone**; an emoji inside ordinary text counts as **in-message**. A message is never split, so its custom emojis are all one kind, and the two counts always add up to the number of tokens that were sent. The leaderboard shows the total with the split in brackets.
- **Windows** are `today` (the current day in `TIMEZONE`), `7d`, `30d` and `all` (default). Prefix also accepts `1d`, `week`, `month` and Arabic `اليوم`/`اسبوع`/`شهر`/`كل`.
- **Most and least.** `order:least` (prefix `least`, `bottom`, `اقل`) lists the quietest emojis first. The least view merges in every emoji currently in the server, so an emoji nobody used appears with **0** instead of disappearing; the most view only lists emojis that were actually used.
- **Paging.** 10 per page with **First / Previous / Next / Last** buttons; `per_page` (1–25) on slash or a number in prefix.
- **Deleted and renamed emojis stay readable.** Usage is stored by emoji id, and the newest known name is kept beside it. A deleted or foreign emoji prints as `` `name` *(not in server)* ``; a current one prints as the real emoji.
- **History can be imported once.** `/emojibackfill start` (owner-only) walks each text channel backwards from the moment live emoji counting began, so nothing is counted twice. It runs in the background, saves a per-channel cursor after every 100-message page, survives restarts, and skips bots, system messages and threads. `/emojibackfill status` shows progress and `/emojibackfill cancel` stops cleanly. This is separate from `/backfill`, which imports activity stats.
- The counts live in the same `data/bot.db` file (`emoji_usage`, `emoji_catalog`, `emoji_meta`, `emoji_backfill`), one row per emoji and day.

## Tickets

`/ticket` (prefix `:-ticket`, aliases `tickets`, `ticket-tool`, `support`) is a fully customizable ticket system. You create **named panels** with their own embeds, and **buttons** that belong to one panel. Nothing is predefined.

- **Create a panel:** `/ticket panel add key:support label:"Support desk" channel:#support title:"Need help?" description:"Choose an option" color:#5865f2 footer:"We reply fast" image:https://… thumbnail:https://…`. Each panel is a separate message with its own embed and its own buttons. Use `none` to clear a value. `/ticket panel post key:support` posts or refreshes it, `/ticket panel edit key:support …` changes it, `/ticket panel list` shows every panel, and `/ticket panel remove key:support confirm:true` deletes the panel and its buttons.
- **Buttons are assigned to a panel.** `/ticket button add key:help label:Help panel:support category:#tickets emoji:🎫 style:success button_label:"Get help" support_roles:@Support ping_roles:@Mods welcome:"Hi {mention}" name_template:"support-{number}" max_open:1 close_action:delete color:#5865f2`. Omitting `panel` puts the button on `main`. Move a button later with `/ticket button edit key:help panel:complaints`. The `key` is the short id used internally; `label` is the name shown in embeds and lists.
- **Every button can look and behave differently.** `style` is `primary` (blue), `secondary` (gray), `success` (green) or `danger` (red). `button_label` overrides the text on the button, `emoji` sets its icon, and `category`, `ping_roles`, `welcome`, `name_template`, `max_open`, `close_action`, `log_channel` and `color` are per button. Edit later with `/ticket button edit key:support …`, remove with `/ticket button remove key:support confirm:true`.
- **Each button counts its own tickets.** `/ticket number key:support start:100` makes that button's next ticket `#0100` and count up from there; every other button keeps its own sequence. Run `/ticket number key:support` to see the current start and next number, `/ticket number` to list every button, or `start:0` to go back to counting from 1. Numbers already handed out are never reused, and because sequences are independent two buttons can both have a `#1`. Prefix: `:-ticket number key=support start=100`.
- **Keep closed tickets in their own category.** Add `closed_category:#closed` to a button (prefix `closed=#closed`) and archived tickets move there when they close; reopening puts them back in the ticket category. Without it, a closed ticket simply stays where it was. Clear it with `closed=none`.
- **Each panel holds up to 25 buttons**, five per row, ordered by `position` then key. A server can have up to 10 panels. Any button change refreshes every posted panel automatically.
- **Split your routes.** Put routine support on a `main` panel and complaints on a separate `complaints` panel: add three buttons (`complaint-submod`, `complaint-mod`, `complaint-owner`) to that panel, each with its own category, ping roles and red `danger` style.
- **Prefix works too:** `:-ticket panel add key=support label="Support desk" title="Need help?" channel=#support`, `:-ticket button add key=support label=Support panel=support category=#tickets ping=@Mods style=success`, and `:-ticket panel edit key=support color=#5865f2`. Use quotes for spaces. `:-ticket panel title="Need help?"` still edits and posts the `main` panel.
- **Placeholders:** channel names understand `{number}`, `{user}`, `{username}` and `{type}`; welcome text understands `{mention}`, `{user}`, `{username}`, `{server}`, `{type}` and `{number}`. Unicode names (including Arabic) are kept as channel names.
- **The ticket opener is pinged for real.** Mentions inside an embed never notify, so the welcome message pings the opener and this button's `ping_roles` (falling back to `support_roles`) from the message content, and only those ids are allowed. No `@everyone` or stray mention can leak from your welcome text.
- **Member commands:** `/ticket close [reason]`, `/ticket claim` (support team, claim or unclaim), `/ticket transcript`, and for staff `/ticket add`, `/ticket remove` and `/ticket rename`. The ticket channel also has **Claim** and **Close** buttons; closing opens a small modal for an optional reason.
- **Closing:** the transcript is written first. If a log channel exists and the button is set to `delete`, the channel is removed; otherwise it is renamed `closed-…`, the opener loses Send Messages, and the channel gets **Reopen**, **Transcript** and **Delete** buttons. A ticket is only deleted after its transcript reached the log, so history is never lost silently.
- **Transcripts** are self-contained HTML files attached to the log channel; without a log channel, `/ticket transcript` sends the file directly to the opener or staff member.
- The bot needs **Manage Channels**, **Manage Messages**, plus **View Channel**, **Send Messages**, **Embed Links**, **Read Message History** and **Attach Files** in the panel, category and log channels. Tickets are not anonymous: the opener is recorded, so staff can follow up.
- Configuration lives in `data/bot.db` (`ticket_panels` for the panels and their embed/message ids, `ticket_types` for the buttons, `ticket_settings` for the log channel, and `tickets` for history). A restart does not lose a posted panel. The old single-panel configuration is migrated once into a `main` panel.

## Moderation

All moderation commands are ephemeral for the moderator and use the audit-log reason `… by <moderator>: <reason>`.

- **Timed actions** accept `40s`, `10m`, `2h`, `7d`, `1w`, or a combination like `1d12h`:
  - `/mute @member 10m spam` adds the **Muted** role for ten minutes.
  - `/timeout @member 2h spam` uses Discord's native timeout (default 10m, capped at 28 days).
  - `/ban @user 7d raiding` bans and lifts automatically when the timer ends. Use the `id` option (or paste the id in prefix) to ban or unban someone who is not in the server.
- **Mute** is role-based: the first use creates a role named **Muted** and denies Send Messages, Add Reactions, Speak and thread creation in every channel (new channels inherit the rule). The role is reused afterwards, and `/unmute` removes it. Bots cannot be muted or timed out; a member with **Administrator** cannot be muted because Administrator bypasses channel overwrites.
- **Hierarchy is enforced.** You must outrank the target unless you own the server or have Administrator, and the bot's highest role must sit above the target's. `/perm` grants never bypass this — they only bypass the command's Discord permission.
- **Temporary mutes and bans live in SQLite** (`moderation_expiries`) and a scheduler checks every minute, so a restart cannot leave someone muted or banned forever. A very short timer can fire up to a minute late.
- **`/perm grant role:@Mods command:kick`** lets that role run `kick` without **Kick Members**, without changing the role's real Discord permissions. `/perm revoke` removes it, `/perm list` shows every grant, and `perm` itself cannot be granted.

Required Discord permissions: `/mute` and `/unmute` need **Manage Roles**; `/timeout` and `/untimeout` need **Moderate Members**; `/kick` needs **Kick Members**; `/ban` and `/unban` need **Ban Members**; `/perm` needs **Manage Server**.

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
- Ping the **member**, not a role — a role mention is rejected (`Unknown member`) rather than treated as "everyone".
- The command's own message is **never deleted**: `:-clear 1` removes the message above it, and with a member filter the command is skipped too. For slash commands there is no command message to skip.

## Exile (prison)

Exile hides every channel from a member by giving them one of your own exile roles. You create the roles; the bot applies the channel rules and hands out the right one.

### One-time setup

1. Create your roles in **Server Settings → Roles** — for example `Exile Main` and `Exile 1` … `Exile 10`.
2. Drag the bot's own role **above all of them** and give the bot **Manage Roles**.
3. Hide the server from each role, listing the channels it may still see:

```
/exile-setup role:@Exile1 except:#exile-chat #rules
:-exile-setup @Exile1 #exile-chat #rules
```

4. Map each role to its level:

```
/exile-role set level:1 role:@Exile1
/exile-role set level:main role:@ExileMain
:-exile-role set 1 @Exile1
:-exile-role list
```

### Using it

```
/exile user:@member                    # main exile
/exile user:@member level:3 reason:spam
:-exile @member 3 spam

/exile-release user:@member reason:appeal accepted
:-exile-release @member appeal accepted

/exile-list
/exile-log channel:#mod-log
```

### What it does

- **`/exile-setup` denies View Channel on every channel and category**, including voice, forum and announcement channels, except the ones you list. Each exception gets an explicit allow, and a category containing an exception is kept visible. A role with no exceptions hides the whole server.
- **The exception list belongs to the role**, so level 1 can see `#exile-1` while level 10 sees only `#exile-10`. Re-running setup replaces that role's list; it never stacks duplicates.
- **One exile role at a time.** `/exile` removes every other exile role before adding the chosen one, and changing a level updates the same record instead of stacking.
- **The server-wide access role is removed too.** Role `1402366805153939667` is taken off the member on exile, because its View Channel allow would otherwise defeat every channel hide. `/exile-release` gives it back. If the bot cannot remove that role (above its own role, or integration-managed), the exile is refused instead of silently doing nothing; if the exile role assignment then fails, the access role is restored.
- **New channels are hidden automatically** (`channelCreate` applies every configured role). A deleted channel is removed from every exception list.
- **Setup is safe to re-run.** Channels that already match are skipped, and the reply reports any channel that could not be edited instead of claiming success.
- **The bot refuses unusable roles:** `@everyone`, integration-managed roles, roles with **Administrator** (it bypasses channel overwrites) and roles above the bot's own highest role.
- **The owner and anyone with Administrator cannot be exiled** — they bypass permissions, so the bot says so rather than pretending.
- **Release and auditing:** `/exile-release` removes the role, `/exile-list` shows who is still exiled, and `/exile-log` posts an embed for every exile, level change and release. A member who leaves the server is released automatically.
- **Manage Server** is required for every exile command. The bot needs **Manage Roles** and access to the channels it edits.
- The roles are only added and removed — **no other member role is touched**.

## Command aliases

An alias turns a word into a command, so you can moderate without the prefix:

```
:-alias add مسح clear       # now: مسح 100
:-alias add نظف clear       # a second word for the same command
:-alias channel مسح allow #staff-chat
:-alias channel مسح deny #general
:-alias channel مسح clear
:-alias channel مسح list
:-alias list
:-alias remove مسح
```

- **Channel rules.** `/alias channel <word> allow #channel` makes the alias work only there; `deny` makes it work everywhere except there; `remove` drops one channel; `clear` returns it to every channel. A thread inherits its parent channel and a channel inherits its category, so a rule on a category covers everything inside.
- Everything after the word becomes the command's arguments: `مسح 100` runs `clear` with `100`. Quotes still group words: `مسح 100 "raid cleanup"`.
- The prefix keeps working: `:-مسح 100` reaches the same alias, and `:-clear 100` is untouched.
- **Only people who could already run the command trigger it.** A member without Manage Messages typing `مسح ...` is treated as ordinary chat — the bot does not answer "Missing permissions" in the channel. A channel rule is silent the same way.
- Real commands win: an alias cannot be named after a command or a built-in alias, and if a command with that name appears later it takes over.
- One word made of letters, numbers, `_` or `-` (up to 32 characters). Arabic is fine, with or without diacritics.
- Common words (`من`, `في`, `هذا`…) are allowed but warned about: every message that starts with that word runs the command. Pick a distinctive word.
- Max 50 per server. **Manage Server** is required to add, remove or restrict one; `/alias list` is open to everyone.
- Permissions and cooldowns are the command's own, because the alias runs the real command through the normal pipeline.
- `/help clear` lists the server's own words next to the built-in aliases (for example `:-purge`, `:-prune`, `:-مسح`), and `/help مسح` opens the `clear` page.

## Personal role colors

`/color primary:#ff0000 secondary:#00ff00` (prefix: `:-color #ff0000 #00ff00`, alias `:-colour`) recolours the **highest role in your profile that nobody else has**, as a two-color gradient. `/colors` (or `:-color list`) shows the whole palette.

- Change just one color: `/color primary:#ff0000` keeps the current second color. For only the second color use `/color secondary:#00ff00`, or in prefix `:-color - #00ff00` (the `-` means "keep the first color").
- Clear the color entirely: `/color clear:true`, `/color primary:clear`, or `:-color clear` (`reset`, `none`, `default`, `مسح`, `افتراضي` also work). The role goes back to Discord's default color; it cannot be combined with new colors in the same command.
- Colors accept `#RRGGBB`, `#RGB`, `0xRRGGBB`, bare hex, English names such as `red`, `blue`, `purple` or `blurple`, **or Arabic names** such as `أحمر`, `أخضر`, `أزرق`, `بنفسجي`, `ذهبي`, `سماوي`, `وردي`, `أبيض`, `أسود`, `رمادي`. Hamza, diacritics, tatweel and the definite article are ignored: `أَحْمَر`, `احمر` and `الأحمر` are the same color.
- Arabic-Indic and Persian digits work in hex too: `#FF٠٠٠٠` and `#۰۰ff۰۰` are understood, so a phone keyboard set to Arabic is not a dead end.
- The bot picks the role; you cannot target someone else's. Shared roles, `@everyone` and integration-managed roles are ignored.
- The role must sit **below the bot's highest role**, and the bot needs **Manage Roles**. If your top personal role is above the bot, the command uses the highest personal role it can still edit and says which one it skipped; it only refuses when every personal role you have is above the bot.
- Gradient colors need a server boost level that supports them. Discord rejects the update otherwise.
- Passing the same color twice makes a solid color. A holographic role is converted back to a normal two-color gradient.
- A 10-second cooldown per member protects Discord's role-update rate limit. A failed attempt (bad color, role out of reach, Discord error, or colors that were already set) does not start the cooldown, so you can fix the input and try again right away.
- `/colors` (prefix `:-colours`, `:-palette`) shows every name with its hex code in Arabic and English; it is a normal command, so a server alias can point at it. `:-color list` and a bare `:-color` show the same list.
- Black is stored as `#000001`: Discord reserves `#000000` for "no color", so a literal black would clear the role. Use `clear`/`مسح` when you actually want the default color.

## Reports, keyword alerts, glossary and automatic reports

An optional AI layer: summarize any channel into a report, get an alert in a chosen channel when a keyword appears, and teach the summarizer your server's vocabulary.

### Setup

The summarizer talks to **any OpenAI-compatible endpoint**, so the provider is a `.env` decision, not a code change:

```env
AI_API_KEY=your-key
# optional, these are the defaults:
AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
AI_MODEL=gemini-3.5-flash-lite
```

For DeepSeek (paid key, no daily free-tier quota):

```env
AI_API_KEY=sk-...
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-flash
AI_THINKING=off
```

`AI_THINKING=off` matters: DeepSeek thinks before answering by default, and the chain of thought is billed as output tokens and can consume the whole `max_tokens` budget before the JSON begins. Summaries do not need it. Leave the variable unset for Gemini — and if it is left over, the client ignores it for Google's endpoint.

To switch back to Gemini, put the Gemini key in `AI_API_KEY` and remove `AI_BASE_URL`, `AI_MODEL` and `AI_THINKING` (or set them to the defaults above), then restart.

Google now limits free API users to **Flash-Lite**; `gemini-3.6-flash` can answer `429 quota exceeded` on a free key even when the key is valid. Use `gemini-3.5-flash-lite` on the free tier, or enable billing for the larger models. If a model stops working, check the error: it names a replacement.

Google AI Studio, OpenAI, OpenRouter, Groq, DeepSeek and a local llama-server all work — only `AI_API_KEY` is required. Restart after adding it. Without a key, `/summary` replies with this snippet instead of crashing.

Grant the bot **Read Message History** in every channel you plan to summarize, and **Manage Messages** for the members who may run the commands.

### Summarizing a channel

Reports go to a **management channel**, never into the channel being summarized:

```
/summary channel channel:#management     # set the destination
/summary run channel:#general hours:24 kind:General
```

| Option | Meaning |
|---|---|
| `channel` | The channel to read (required for `run`) |
| `hours` | How far back, 1–168 (default 24) |
| `kind` | `General` (topics, news, decisions), `Action items` (requests, problems, owners), `Targeted` (needs `prompt`) |
| `prompt` | The focus for a Targeted summary, e.g. `the new spawn rules` |
| `private` | Show the report only to you and skip the management channel |

Prefix form, order-independent:

```
:-summary run #general 2h
:-summary #general 24h tasks
:-summary #general 7d ask when is the next event
:-summary 1h general private
```

- **Nothing is archived.** The bot reads Discord's own history, page by page, so there is no message log on disk. A window is capped at 3,000 scanned messages; if it hits that, the report says so and you narrow the window.
- Long windows are split into parts and merged by a second model call, so a 7-day summary still fits the context.
- Each report is stored in SQLite (structure, not transcript), so `/summary history` and `/summary export` never call the model again.
- Reports never ping anyone, and the model is told to use only the transcript, in the language people actually spoke.
- **People keep their real names.** The transcript uses the member's nickname (or global name) instead of the raw handle, so the model writes `It's Emad` and not `e_a_0`. When the report is in Arabic, Latin names are written in Arabic letters: `It's Emad` becomes **عماد**, `ShinIsekai` becomes **شين ايسكاي**.
- **Headings follow the report language.** An Arabic report is titled `ملخص عام` and uses `المواضيع` / `القرارات` / `المهام` / `أسئلة مفتوحة` / `أبرز المقولات`, with `233 رسالة` in the footer. English reports are unchanged, and the HTML export uses the same labels.
- **The layout follows the SummaryBot style.** The first line is `نظرة عامة: #channel` (or `Overview: #channel`), then `📋 مناقشات رئيسية`, `✅ قرارات متخذه`, `📢 إعلانات`, `❓ أسئلة مطروحة` (plus `📌 مهام` and `💬 أبرز المقولات` when present). Each item is a bold heading followed by a paragraph, topics carry a **[Jump]** link to the source message, and the footer reads like `آخر 24 ساعة | تم تحليل 200 رسالة` or `Scheduled - Daily 04:00 Asia/Amman | 200 messages analyzed`. Continuations are titled `الجزء 2/2`.
- **Summaries are complete but concise.** The model is asked to cover every distinct subject, decision, announcement, request, problem, number and link, but each topic is only 2–3 sentences and a full day targets 300–500 words. Up to 12 topics, 15 decisions, 10 announcements, 20 action items, 10 questions and 6 quotes survive; a longer report simply spills into a second or third **message** (Discord limits the combined characters of every embed in one message to 6,000, so each embed goes on its own message).
- A free AI key is enough. Length is limited by the prompt and the output budget, not by the free tier: Gemini's free quota is a **rate limit** (requests and tokens per minute/day), not a shorter answer. A paid key matters only if you summarize many times per hour, or want a bigger model. `AI_MAX_INPUT_CHARS` (default 60,000) is the other ceiling — raise it for very long windows.
- **A paid key costs cents, not dollars.** Providers bill per token. On `deepseek-flash` (off-peak: $0.15 per 1M input, $0.60 per 1M output; peak is double), a channel with ~30,000 characters of chat per day is ~15,000 input tokens, so a daily report is roughly **$0.003–0.007**. An hourly schedule lands around **$0.02–0.04/day**, and every 15 minutes around **$0.10–0.20/day** — output length, not transcript volume, is the main driver, which is why `AI_THINKING=off` matters.

### Exporting

`/summary export [id]` sends a **single self-contained HTML file** (latest report by default). Open it in any browser and use **Print → Save as PDF**.

That is deliberate: a real PDF with Arabic text needs a bundled font plus shaping support, while the browser has both already. The export detects Arabic content and lays the page out right-to-left, escapes HTML, and has a print stylesheet (`@media print`) so the PDF has no margins or hint boxes.

The 📄 button under a report does the same thing. It is handled by the bot globally, not by a five-minute listener, so it keeps working days later and after restarts — including on reports the scheduler posted at 07:00. Moderators and whoever scheduled the report can press it.

A report with nothing worth saying (an empty model answer, or a window with no messages) is **not posted at all** — the scheduler just logs it and waits for the next run, instead of sending a heading with a dead button.

### Keyword alerts

```
/watch channel channel:#mod-log    # prefix: :-watch channel #mod-log
/watch add keyword:nitro scam       # prefix: :-watch add nitro scam
/watch list
/watch remove keyword:nitro scam
/watch clear
/watch test                         # post a sample alert in the chosen channel
/watch ignore channel:#off-topic    # never alert on words here (a category covers its channels)
/watch ignored                      # list ignored channels
/watch unignore channel:#off-topic  # alert there again
```

When anyone posts a watched word **anywhere** in the server, the bot posts an alert in the channel set with `/watch channel`: the word, the author, a short quote, and a **clickable jump link** to the message. Channels you add with `/watch ignore` are skipped entirely — no alert, no ping.

- The list is **shared by the whole server**. Any moderator can add or remove a word, everyone sees the same list, and every alert goes to the same channel — it is no longer tied to whoever typed the command (and no DMs are involved).
- Matching is whole-word and Unicode aware: `ass` does not fire on `classic`, and Arabic diacritics, tatweel and the alef/ya/ta-marbuta variants are normalized so `مُحَمّد` matches `محمد`. Adding `محمد` when `مُحَمّد` is already watched is refused as a duplicate.
- Bots never trigger an alert. Messages are checked even if the author is a moderator, so typing the word is a quick live test.
- **Every alert pings `@everyone`.** The mention lives in `content`, outside the embed (Discord ignores mentions inside embeds), exactly like a birthday greeting; `allowedMentions` only allows `everyone`, so a quoted message can never ping a role or an arbitrary member. If the bot lacks **Mention Everyone** in the alert channel, the ping is dropped silently and the failure is logged once per half hour.
- **Ignored channels stay quiet.** `/watch ignore` takes a channel or a whole category (ignoring a category covers every channel under it, and threads inherit both). `/watch unignore` restores alerts, `/watch ignored` lists what is ignored and who added it. A deleted channel drops off the list automatically.
- At most 50 keywords per server, 2 seconds apart and 12 per 10 minutes, so a busy phrase cannot flood the channel. Several watched words in one message produce one alert, not one per word.
- Choosing the channel needs **Manage Server**; adding, removing, listing and testing need **Manage Messages**.
- `/watch test` posts a real sample in the alert channel, so a wrong channel or missing permission is visible immediately instead of silently failing.
- If the channel is deleted or the bot loses access, the failure is logged once per half hour and alerts resume as soon as a valid channel is set.

The glossary and the alert list are per server.

### Glossary

```
/glossary add term:nap meaning:the new event map
/glossary list
/glossary remove term:nap
/glossary clear
```

Up to 200 terms (**Manage Server** required to change them) are sent with every summary as context, so the model stops guessing at acronyms and map names. `/glossary list` is open to everyone so members can see how the server's jargon is being described.

### Automatic reports

`/autoreport` (aliases `/schedule`, `/digest`) posts a report on its own, so nobody has to remember to run one:

```
/autoreport set channel:#general every:6h
/autoreport set channel:#general time:09:00 kind:Action items
/autoreport set channel:#news time:21:30 kind:Targeted prompt:the event schedule
/autoreport list
/autoreport pause channel:#general
/autoreport resume channel:#general
/autoreport remove channel:#general
```

Prefix form, order-independent:

```
:-autoreport set #general 6h
:-autoreport set #general 09:00 tasks
:-autoreport set #news 2d ask the event schedule
:-autoreport list
```

| Option | Meaning |
|---|---|
| `channel` | The channel to read. One schedule per channel — setting it again replaces the old one |
| `every` | Interval between reports: `90m`, `6h`, `2d` (15 minutes to 7 days) |
| `time` | Daily at `HH:MM` in the server time zone, 24-hour |
| `kind` | Same three kinds as `/summary run` |
| `prompt` | Required for `Targeted` |

Give **either** `every` **or** `time` — never both, never neither. Prefix form decides by shape: a colon means a clock (`09:00`), otherwise a duration (`6h`).

- Reports land in the **management channel** from `/summary channel`, so set that first; the command refuses to schedule otherwise and tells you why. A scheduled report is never posted into the channel it just read.
- The window is the time since the last run, capped at 7 days. Nothing is summarized twice, and setting the schedule again restarts the window from now — so a report one minute after `set` covers one minute, not the whole day. The confirmation message says this when it matters.
- A window with no messages is skipped silently, so an idle channel does not produce empty reports. The same applies when the model finds nothing worth reporting: nothing is posted, and the console logs the reason (`no messages` or `the model found nothing to report`).
- A minute-level tick checks the schedules; the first check runs at boot, so a report that came due while the bot was offline still fires (within the 7-day cap). Everything else is the same pipeline as a manual run — same prompt, same glossary, same export button.
- Times follow the server time zone (`/birthday timezone default:true` sets it); interval schedules count from the last run regardless of zone.
- Max 10 schedules per server. **Manage Server** required to change them; `/autoreport list` is open to everyone.

## Birthdays

One command, eleven subcommands — each works as a slash command and with the prefix:

| Subcommand | Who | What it does |
|---|---|---|
| `/birthday set <month> <day> [year] [user]` | everyone | Save or update your birthday (admins: set someone else's) |
| `/birthday remove` | everyone | Delete your birthday |
| `/birthday show [visible]` | everyone | Show or hide the birthday, age and time zone block on your profile card |
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
:-birthday show off
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

### Birthday privacy on the card

Each member controls their own birthday block. The card shows the date, current age and effective time zone by default; `/birthday show visible:false` (prefix `:-birthday show off`) hides all three together, and `/birthday show visible:true` brings them back. The setting is stored per member per server and can be changed before a birthday is saved. Staff cannot toggle it for someone else.

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
| **Poster** | Full-width server banner (or your GIF) with one headline |
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

### GIF on any card

Every card's edit form ends with a **GIF URL (optional)** box — `/welcome edit style:Story` → change the text and the GIF together, with the current URL prefilled. Empty it (or type `none`) to remove the image.

`/welcome gif style:<style> url:<link>` does the same from outside the form; the style is optional and defaults to Classic, and `/welcome gif` alone shows the current GIF.

Each card stores its **own** GIF. On Poster the GIF replaces the server banner; on the other styles it sits under the text.

Because Discord allows only five inputs in a modal, three cards pair two labels into one box: Classic `Created | Joined`, Ledger `account | next`, Concierge `📜 Rules | 👋 Say hi`. A single value names both.

Use a **direct image URL** — a Tenor or Giphy *page* link passes validation but will not render.

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
      alias.js          admin-defined words that run a command
      profile.js        generated profile card (PNG attachment)
    community/
      birthday.js       birthday registry + automatic role
      welcome.js        welcome cards
      summary.js        AI channel summaries + export
      watch.js          shared keyword alerts posted to one channel
      glossary.js       server jargon for the summarizer
      autoreport.js     scheduled summaries (interval or daily)
    moderation/
      clear.js          bulk message deletion with author filter
      profile-edit.js   title + points, Manage Server or /perm grantable
      exile.js          assign an exile level to a member
      exile-setup.js    hide channels from an exile role, with exceptions
      exile-role.js     map main / 1-10 to exile roles
      exile-release.js  remove a member's exile role
      exile-list.js     active exiles
      exile-log.js      audit channel for exile actions
  events/
    ready.js            presence, slash registration, scheduler start
    guildMemberAdd.js   welcome card delivery
    guildMemberRemove.js automatic release when an exiled member leaves
    channelCreate.js    apply exile rules to new channels
    channelDelete.js    drop deleted channels from exception lists
    interactionCreate.js
    messageCreate.js    prefix parsing, command aliases, keyword alerts
  handlers/
    command-registry.js slash command payloads + registration
  services/
    birthday-store.js   SQLite queries for birthdays and settings
    birthday-roles.js   role add/remove with permission-safe errors
    birthday-greetings.js greeting rendering, preview, delivery + dedupe
    birthday-scheduler.js per-member reconciliation + scheduler
    profile-store.js    points, titles, XP/level math, punishment weights, rank
    profile-card.js     canvas renderer: template, fonts, panels, XP bar
    welcome-store.js    welcome settings, per-style text and GIFs
    welcome-styles.js   the six card layouts and their text pieces
    summary-source.js   reads Discord history, builds the transcript
    summary.js          prompts, chunk/merge, rendering
    report-store.js     summary channel, saved reports, glossary, schedules
    report-runner.js    shared read → summarize → render pipeline
    report-export.js    self-contained HTML/PDF-ready export
    summary-scheduler.js interval/clock math + the minute-level tick
    watch-store.js      shared keyword list + alert channel
    exile-store.js      exile levels, roles, exceptions and audit rows
    exile.js            permission apply/reconcile, role assignment, audit embeds
    alias-store.js      per-server word -> command rows
    alias-runner.js     turns a bare word message into a command run
    watch.js            matching, Arabic normalization, channel delivery
  lib/
    ai.js               OpenAI-compatible client + error hints
    context.js          unified slash/prefix context
    db.js               SQLite connection + schema
    dates.js            time zone and birthday date math
    embeds.js           embed helpers + colour palette
    loaders.js          recursive command/event loader
    logger.js           levelled logger
    media.js            image URL validation
    net-check.js        DNS → TCP → TLS → HTTPS probe for hosting issues
    resolve.js          role/channel/member tokens for prefix commands
    run-command.js      shared execution pipeline
    runtime.js          Node capability checks
    template.js         placeholder substitution
assets/
  profile/
    card.png            profile card artwork (1868×1200)
    fonts/              Inter + Noto Sans Arabic, with the OFL license
```

## Adding a command

See [`docs/adding-commands.md`](docs/adding-commands.md).

## Troubleshooting

**`Used disallowed intents` on startup** — enable **Message Content Intent**, **Server Members Intent** and **Presence Intent** in the Developer Portal (Bot → Privileged Gateway Intents), then restart.

**`Invalid token`** — re-copy the token; it resets if you press Reset Token again.

**Slash commands don't appear** — set `GUILD_ID` in `.env` and restart, or run `deploy.bat`. Global commands can take up to an hour.

**`npm.ps1 cannot be loaded`** — this machine blocks PowerShell scripts. Use the `.bat` files instead of `npm run`; they call the portable Node directly.

**Bot offline after reboot** — running on this PC only works while the PC is on and awake. See hosting notes below.

**A change isn't live after a restart** — run `/botinfo` (or `:-info`) and read the **Build** field. It shows the commit the running files were built from, e.g. `` `1a2b3c4` · 2026-11-08 ``: the zip made by `package.bat` carries a `build.json`, and a git checkout is asked directly. If it is still the old commit, the new files never reached the server — re-upload the zip (extract with overwrite) or check the panel's `git pull` line, that `.git` exists in the bot folder, and that `AUTO_UPDATE=1` is set. The boot log prints the same line as `Build 1a2b3c4 (2026-11-08)`.

**Prefix command shows no "bot is typing…"** — the indicator is prefix-only (slash commands use Discord's native "thinking…" state) and Discord clears it the moment the reply is posted, so instant commands may never paint it. `:-profile` renders a card for a second or more and should show it. Confirm the build first with `/botinfo`: an old commit has no typing call at all. If the build is current and the bot still cannot type, the console logs `[context] Could not show the typing indicator: …` with Discord's reason (usually a missing **Send Messages** permission in that channel).

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
