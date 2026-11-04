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
| `/botinfo` | `:-info`, `:-stats` | Uptime, servers, memory, versions |
| `/color [primary] [secondary]` | `:-colour`, `:-colors`, `:-لون`, `:-الوان` | Recolor or clear the highest role that only you have |
| `/birthday <subcommand>` | `:-bd`, `:-bday` | Birthday registry, countdowns, automatic birthday role and greetings |
| `/welcome <subcommand>` | `:-greet` | Welcome cards for new members: six styles, random or rotating, editable text |
| `/clear <amount> [user]` | `:-purge`, `:-prune` | Delete recent messages, optionally only from one member |
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
| `/alias <subcommand>` | `:-shortcut`, `:-aliases` | Run a command by typing a word, with no prefix |

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
:-alias list
:-alias remove مسح
```

- Everything after the word becomes the command's arguments: `مسح 100` runs `clear` with `100`. Quotes still group words: `مسح 100 "raid cleanup"`.
- The prefix keeps working: `:-مسح 100` reaches the same alias, and `:-clear 100` is untouched.
- **Only people who could already run the command trigger it.** A member without Manage Messages typing `مسح ...` is treated as ordinary chat — the bot does not answer "Missing permissions" in the channel.
- Real commands win: an alias cannot be named after a command or a built-in alias, and if a command with that name appears later it takes over.
- One word made of letters, numbers, `_` or `-` (up to 32 characters). Arabic is fine, with or without diacritics.
- Common words (`من`, `في`, `هذا`…) are allowed but warned about: every message that starts with that word runs the command. Pick a distinctive word.
- Max 50 per server. **Manage Server** is required to add or remove one; `/alias list` is open to everyone.
- Permissions and cooldowns are the command's own, because the alias runs the real command through the normal pipeline.
- `/help clear` lists the server's own words next to the built-in aliases (for example `:-purge`, `:-prune`, `:-مسح`), and `/help مسح` opens the `clear` page.

## Personal role colors

`/color primary:#ff0000 secondary:#00ff00` (prefix: `:-color #ff0000 #00ff00`) recolours the **highest role in your profile that nobody else has**, as a two-color gradient.

- Change just one color: `/color primary:#ff0000` keeps the current second color. For only the second color use `/color secondary:#00ff00`, or in prefix `:-color - #00ff00` (the `-` means "keep the first color").
- Clear the color entirely: `/color clear:true`, `/color primary:clear`, or `:-color clear` (`reset`, `none`, `default`, `مسح`, `افتراضي` also work). The role goes back to Discord's default color; it cannot be combined with new colors in the same command.
- Colors accept `#RRGGBB`, `#RGB`, `0xRRGGBB`, bare hex, English names such as `red`, `blue`, `purple` or `blurple`, **or Arabic names** such as `أحمر`, `أخضر`, `أزرق`, `بنفسجي`, `ذهبي`, `سماوي`, `وردي`, `أبيض`, `أسود`, `رمادي`. Hamza, diacritics, tatweel and the definite article are ignored: `أَحْمَر`, `احمر` and `الأحمر` are the same color.
- Arabic-Indic and Persian digits work in hex too: `#FF٠٠٠٠` and `#۰۰ff۰۰` are understood, so a phone keyboard set to Arabic is not a dead end.
- The command also answers to `:-لون` and `:-الوان` (prefix) next to `:-color`, `:-colour`, `:-colors`.
- The bot picks the role; you cannot target someone else's. Shared roles, `@everyone` and integration-managed roles are ignored.
- The role must sit **below the bot's highest role**, and the bot needs **Manage Roles**. If your top personal role is above the bot, the command uses the highest personal role it can still edit and says which one it skipped; it only refuses when every personal role you have is above the bot.
- Gradient colors need a server boost level that supports them. Discord rejects the update otherwise.
- Passing the same color twice makes a solid color. A holographic role is converted back to a normal two-color gradient.
- A 30-second cooldown per member protects Discord's role-update rate limit. A failed attempt (bad color, role out of reach, Discord error, or colors that were already set) does not start the cooldown, so you can fix the input and try again right away.

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
    community/
      birthday.js       birthday registry + automatic role
      welcome.js        welcome cards
      summary.js        AI channel summaries + export
      watch.js          shared keyword alerts posted to one channel
      glossary.js       server jargon for the summarizer
      autoreport.js     scheduled summaries (interval or daily)
    moderation/
      clear.js          bulk message deletion with author filter
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
