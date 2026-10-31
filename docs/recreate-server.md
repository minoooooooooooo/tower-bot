# Rebuilding the Wispbyte server from scratch

Use this when the existing server directory cannot be cleaned (the undeletable
`src\boot.js` / `docs\...` files from the old bad zip), or when the node's IP is
being rate limited by Discord (HTTP 429 on `discord.com/api/v10/gateway`).

A fresh server starts with an **empty directory**, which is the one condition the
egg's install script needs to clone the repo properly. That is the whole point of
rebuilding: `Reinstall` can never clone while those stray files exist.

## Before deleting anything

Two files must be in your hands, not just on the server:

| File | Where | Verified |
|---|---|---|
| `bot.db` | desktop copy, e.g. `bot-final.db` | **25 birthdays** + guild settings + 2 greeting records, 2026-10-31 |
| `.env` | desktop copy (`.env`) | 6 keys, token validated with `GET /users/@me` → 200 |

> **Stop the server before downloading `bot.db`.** In WAL mode the newest commits
> live in `bot.db-wal` until a clean shutdown checkpoints them into `bot.db`. A
> download taken while the bot is running can be hours stale and looks perfectly
> valid — this cost half an hour on 2026-10-31, when a 12:07 copy held 2 of 25
> birthdays. After stopping, `data/` should hold only `bot.db`: a remaining
> `bot.db-wal` means the checkpoint did not run.
>
> Count the rows, don't assume:
>
> ```
> node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('bot.db',{readOnly:true});console.log(d.prepare('select count(*) c from birthdays').get())"
> ```

The code is **not** a backup concern — it is in
<https://github.com/minoooooooooooo/tower-bot>.

## 0. Record the current settings

Screenshot the **Startup** tab and the server's **Settings** before deleting. You
need to recreate: the egg name, `JS_FILE`, `AUTO_UPDATE`, `USER_UPLOADED_FILES`,
and the `GIT_*` fields. Everything else is the egg's default.

## 1. Delete the old server

Panel → your server → **Settings** → **Delete Server** → confirm.

Nothing is lost that is not already downloaded.

## 2. Create the new server

- **Egg:** the Node.js egg (`parkervcp/yolks`), Node 26 image. Any Node ≥ 22.5
  works — the boot guard refuses older runtimes with a clear message.
- **Plan/location:** free tier, any location. A different node is preferable; a
  different IP is the point.
- **Name:** anything, e.g. `tower-bot`.

Do **not** start it yet.

## 3. Set the variables before the first install

| Variable | Value |
|---|---|
| `JS_FILE` | `src/boot.js` |
| `GIT_REPO_ADDRESS` | `https://github.com/minoooooooooooo/tower-bot.git` |
| `GIT_BRANCH` (or "Install Branch") | `main` |
| `USER_UPLOADED_FILES` | `0` — the installer clones the repo |
| `AUTO_UPDATE` | `1` — `git pull` on every start |
| `GIT_USERNAME` | *(empty — public repo)* |
| `GIT_ACCESS_TOKEN` | *(empty — public repo)* |

The startup command itself is the egg's default and does not need editing:

```
if [[ -d .git ]] && [[ ${AUTO_UPDATE} == "1" ]]; then git pull; fi
if [ -f /home/container/package.json ]; then npm install; fi
node /home/container/${JS_FILE}
```

## 4. Install

Create/finish the server and let the installer run. Watch for:

```
Cloning into '.'...
```

If it says the directory is not empty, the install ran before the variables were
saved — empty the directory and press **Reinstall**.

## 5. Verify the clone

Files tab, server root:

- `src/`, `docs/`, `package.json`, `package-lock.json`, `.git`
- **no** `.env`, **no** `data/` — that is correct, they are gitignored

## 6. Create `.env`

Files → root → **New File** → name `.env` → paste the six lines → Save.

Use the editor rather than uploading the file: an uploaded `.env` trips the
panel's secret scanner. The content is:

```
DISCORD_TOKEN=...
CLIENT_ID=1558788065873371138
GUILD_ID=1396303120929259642
PREFIX=:-
TIMEZONE=Asia/Riyadh
LOG_LEVEL=info
```

## 7. Restore the database

Files → **New Folder** → `data` → open it → upload `bot.db`.

Do this **before** the first start; otherwise the bot creates `data/` with an
empty database and you have to delete it first.

## 8. Start and verify

Expect, in order:

```
Already up to date.            (or a pull, if new commits exist)
up to date, audited N packages
INFO  [boot] Runtime Node 26.x
INFO  [bot] Loaded 5 command(s)
INFO  [bot] Loaded 3 event(s)
INFO  [bot] Connecting to the Discord gateway...
INFO  [ready] Logged in as 11/10#8627
INFO  [ready] Serving 1 server(s)
INFO  [bot] Registered 5 slash command(s)
```

If instead you see `no gateway connection after 60s` followed by `[net] ... http
... -> HTTP 429`, the new node is rate limited too — send the ticket in
`docs/HANDOFF.md` issue 12. The bot keeps retrying every minute, so it will
recover by itself if the limit clears.

## 9. Verify in Discord

- `:-birthday list` → 2 rows, dates and zones intact, no trailing `@`
- `:-ping` → responds

## After the rebuild

- Deploying a change is now `git push` + panel **Restart**. Nothing is uploaded.
- **Do not upload zips** and do not press **Reinstall** while the bot works — the
  clone already happened and a reinstall would only risk the directory.
- Free tier still needs a panel login every two weeks.
- Keep downloading `data/bot.db` after meaningful changes; it is the only copy.
