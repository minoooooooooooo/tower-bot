# Deploying the bot to a free panel (Wispbyte)

The bot runs perfectly on a free Discord-bot panel. This guide uses
**Wispbyte** (`wispbyte.com`) because it is the free host with a verifiable
track record: founded 2023, 350k+ users, a public status page, and free
servers that are never deleted.

| | Wispbyte free tier |
|---|---|
| Cost | €0 forever, **no card** |
| RAM / disk | 512 MB / 1 GB |
| Uptime | 24/7, no sleep |
| Catch | Log in once every 2 weeks or the server stops (you get emailed) |
| Location | Romania |

That is plenty for this bot: Node + discord.js idles around 60–120 MB, and the
SQLite database stays in the low kilobytes for a server of a few hundred
members.

> **Before you start, read the two hard requirements in
> [Host requirements](#host-requirements).** Panels occasionally ship a Node
> version too old to run the bot, and that is the one thing you cannot fix from
> inside the code.

---

## Host requirements

1. **Node 22.5 or newer** (24 recommended). The bot uses Node's built-in
   `node:sqlite`, which does not exist in older versions. `src/boot.js` checks
   this at startup and prints the exact fix if it is wrong.
2. **A disk that survives restarts.** `data/bot.db` holds every birthday and
   server setting. If the host wipes the filesystem on redeploy, members'
   birthdays vanish. Wispbyte's 1 GB is real file storage.

Everything else — Docker, SSH, ports — is unnecessary. The bot only makes
outbound connections.

---

## Step 1 — Build the upload package

On your PC, double-click **`package.bat`**.

That produces `dist/bot.zip` containing `src/`, `package.json`,
`package-lock.json`, `.env.example`, `README.md` and `docs/`.

`node_modules/`, `data/` and `.env` are deliberately excluded:

- the panel installs dependencies itself,
- the server starts with an empty database,
- **your token must be typed into the panel, not shipped in a zip.**

---

## Step 2 — Create the server

1. Sign up at <https://wispbyte.com/client/register> (email, Google, or GitHub).
2. **Create Server** → **Free Plan** → name it, for example `discord-bot`.
3. Pick the **Node.js** Docker image. Choose the newest Node.js option the
   panel offers — 24 if it is listed.
4. Create it and open the server console once so the panel finishes setting up.

---

## Step 3 — Upload the code

1. Open the server → **Files** (or the file manager tab).
2. Upload `dist/bot.zip` to the root of the server directory.
3. Unzip it there, so the layout is:

```
package.json
package-lock.json
src/boot.js
src/index.js
src/commands/...
src/events/...
docs/...
```

If the panel cannot unzip, upload the contents of `dist/bot.zip` folder by
folder instead.

**Verify the extraction:** the file manager must show `src` and `docs` as
**folders** you can open. If you instead see flat files named `src\boot.js` or
`docs\adding-commands.md`, the zip was built with Windows path separators
(PowerShell's `Compress-Archive` does this). Rebuild with `package.bat` — the
current script writes POSIX paths and refuses to emit a zip containing
backslashes — then extract the new zip.

Those stray entries can stay where they are: on Linux `src\boot.js` is just an
oddly named file, and it does not collide with a real `src/boot.js` inside a
directory. Some panels refuse to delete them (*"One or more filenames are
invalid"*) because their filename validation rejects backslashes; leave them
alone. They waste a few kilobytes and nothing else. Remove them with SFTP if it
is available, or recreate the server if the clutter bothers you.

---

## Step 4 — Point the egg at the bot's entry file

Open the server → **Startup** in the sidebar (shown as **Startup Settings**).
The **Server Configuration** block is the host's Node "egg" config — it holds
build/git settings, **not** the bot's settings. Fill it in like this:

| Field | Value | Why |
|---|---|---|
| Git Repo Address | *empty* | the code is uploaded, not cloned |
| Install Branch | *empty* | no repo, no branch |
| User Uploaded Files | `1` | tells the installer to skip the git clone; left at `0` it tries to clone an empty repo and fails |
| Auto Update | `0` | nothing to pull |
| **JS file** | `src/boot.js` | **the important one** — this is the file Node runs. The default `index.js` does not exist, so the bot crashes instantly if this is wrong |
| Git Username | *empty* | |
| Git Access Token | *empty* | never paste a Discord token here |
| Uninstall Node packages | *empty* | |

Each field has its own **Save** button — press it for `JS file` and
`User Uploaded Files` at minimum.

---

## Step 5 — Create the `.env` file

This egg exposes no variable fields, so the token goes in a `.env` file, which
`src/config.js` loads through `dotenv`.

1. Sidebar → **Files** → **New File**.
2. Name it exactly `.env` (leading dot, no extension).
3. Paste and save:

```
DISCORD_TOKEN=your-token-here
CLIENT_ID=1558788065873371138
GUILD_ID=your-server-id
PREFIX=:-
TIMEZONE=Asia/Manila
LOG_LEVEL=info
```

Only `DISCORD_TOKEN` and `CLIENT_ID` are required — `PREFIX` defaults to `:-`,
`TIMEZONE` to `UTC`, `LOG_LEVEL` to `info`. If the time zone stays UTC, fix it
from Discord instead: `/birthday timezone default:true zone:<IANA>`.

Anyone who can open the panel's file manager (including support staff) can read
`.env`, and it is easy to leak by screenshotting the file list. Never put it in
a zip you share, and rotate the token in the Developer Portal if it escapes.

---

## Step 6 — Check the startup command

Scroll up to **Startup Command** on the same page. A Node egg normally ships
something that installs dependencies and then runs the entry file:

```
... npm install ... /usr/local/bin/node /home/container/{{JS_FILE}}
```

If `{{JS_FILE}}` is there and `npm install` runs when `package.json` exists,
change nothing. If the command does not install dependencies, replace it with:

```
if [[ -f package.json ]]; then npm install --omit=dev; fi; node src/boot.js
```

On Node 22.5–23.3 only, the flag is still required:

```
if [[ -f package.json ]]; then npm install --omit=dev; fi; node --experimental-sqlite src/boot.js
```

`src/boot.js` prints exactly which of these to use if something is wrong — read
the console before changing anything blindly.

---

## Step 7 — Start and verify

Press **Start**, then read the console. A healthy boot looks like:

```
INFO  [boot] Runtime Node 24.x.x
INFO  [bot] Loaded 5 command(s)
INFO  [bot] Loaded 3 event(s)
INFO  [bot] Logged in as YourBot#1234
INFO  [bot] Registered 5 slash command(s) to guild ...
```

That first line is your Node version check — the panel console cannot run shell
commands like `node -v`, so this is how you find out what image you got. If it
reports anything below `22.5`, the bot cannot run on that image.

Then in Discord:

- `:-ping` → embed with latency
- `:-clear 5` in a scratch channel
- `/birthday set 5 14` → saves a birthday
- `/help` → lists all five commands

If you instead see `Cannot find module 'node:sqlite'` or the boot guard's
explanation, the image is too old — see [Troubleshooting](#troubleshooting).

---

## Step 8 — Confirm the database survives a restart

This is the one check worth doing before you trust the host:

1. Run `/birthday set` for yourself.
2. Press **Restart** in the panel.
3. Run `/birthday list`. Your row must still be there.

If it is gone, the disk is ephemeral. Move to a host with persistent storage
before inviting the bot to a real server.

---

## Step 9 — Keep it alive

- **Log in at <https://wispbyte.com/client> every 2 weeks.** This is the only
  maintenance task on the free tier; Wispbyte emails you before and after a
  stop, but do not rely on the email.
- The panel restarts the process if it crashes. `docker-compose.yml`'s
  `restart: always` only matters on a VM, not here.
- The birthday scheduler runs inside the bot. While the server is stopped,
  greetings for that window are delivered when it comes back — stale ones are
  skipped rather than spammed, so a two-day outage does not post two days of
  greetings.

---

## Backups

`data/bot.db` is the whole state of the bot. Download it every few weeks:

1. **Stop the server first.** This is not optional — see the warning below.
2. Files → `data/bot.db` → **Download**.
3. Keep it somewhere outside the host, named like `bot-2026-10-30.db`.
4. Start the server again.

To restore: upload the file back to `data/bot.db` and start.

> **A copy taken while the bot is running can silently be stale.**
> The database runs in WAL mode, so a commit lands in `bot.db-wal` and is only
> merged into `bot.db` at a checkpoint — which happens when the last connection
> closes. Downloading `bot.db` from a running server can therefore hand you a
> file that is hours behind, and nothing about it looks wrong.
>
> It happened on 2026-10-31: a backup taken at 12:07 held 2 birthdays while the
> server held 25. The clean shutdown at 12:54 checkpointed the rest.
>
> So: **stop, then download**, and afterwards `data/` should contain only
> `bot.db` (a leftover `bot.db-wal` means the checkpoint did not run). Then
> verify the row count rather than assuming:
>
> ```
> node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('bot.db',{readOnly:true});console.log(d.prepare('select count(*) c from birthdays').get())"
> ```

Losing the database means losing every birthday, greeting message, channel and
time zone setting — not the bot itself, which redeploys from GitHub in a minute.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| **"Missing Main File"** on Start | the configured entry file does not exist — almost always a mis-extracted zip | open the main-file picker, browse into `src`, choose `boot.js`; if `src` is not a folder there, see the row below |
| File manager lists `src\boot.js`, `docs\...` as single files | zip built with Windows separators | rebuild with `package.bat`, then extract again — **the stray files can be left in place** |
| Deleting those stray files fails with *"One or more filenames are invalid"* | the panel validates names on delete, and a backslash fails its check | don't delete them; `src\boot.js` (a filename) and `src/boot.js` (a file in a folder) coexist harmlessly on Linux. If the clutter matters, remove the whole server and recreate it, or use SFTP when available |
| `[boot] Node x.y.z cannot load "node:sqlite"` | Image older than Node 22.5 | Ask support for Node 24, or recreate the server with a newer Node.js image |
| `Cannot find module 'discord.js'` | Dependencies not installed | Startup command `npm ci --omit=dev && node src/boot.js` |
| `TokenInvalid` | Wrong or truncated token | Re-copy from Developer Portal → Bot → Reset Token |
| `Used disallowed intents` | Message Content Intent off | Developer Portal → Bot → Privileged Gateway Intents → enable **Message Content Intent** |
| Prefix commands do nothing, slash works | Message Content Intent still off, or wrong `PREFIX` | Check the intent first; then confirm `PREFIX=:-` |
| `/clear` says missing permissions | Bot lacks Manage Messages | Give the bot role **Manage Messages** + **Read Message History** |
| Birthday role never granted | Role above the bot's role, or no Manage Roles | Drag the bot's role above the birthday role |
| Server stopped itself | 2-week login missed | Log in, press Start |
| `no gateway connection after 60s (ws=CLOSED)` then `[net] ... http ... HTTP 429` | the node's shared IP is rate limited/blocked by Discord — no bot on that node can connect | send the ticket in [`HANDOFF.md`](HANDOFF.md) issue 12, or rebuild onto a different node with [`recreate-server.md`](recreate-server.md). The bot retries every minute, so it recovers by itself if the limit clears |
| Reinstall finishes but nothing is cloned | the install script needs an empty directory and the stray files from the bad zip cannot be deleted | rebuild the server: [`recreate-server.md`](recreate-server.md) |

---

## If Wispbyte does not work out

The deployment is intentionally portable: `dist/bot.zip` + the environment
variables + the same startup command works on any Node host. Fallback order:

1. **Raven Host** (`ravenhost.space`) — free, no card, Node 22 advertised,
   larger quoted specs. Newer and unverified, so treat it as a backup, and
   confirm the RAM it actually grants before relying on it.
2. **Azure for Students** — a real VM with no card, if you have a school email.
3. **Oracle Cloud Always Free** — needs a card for verification; see
   [`deploy-oracle.md`](deploy-oracle.md).

Nothing in the code is Wispbyte-specific, so switching is an upload plus the
same six environment variables.
