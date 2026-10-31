# GitHub auto-deploy (Wispbyte)

Goal: stop uploading files by hand. Push to GitHub, restart the server, the
panel pulls the new code itself.

The Node "egg" on Wispbyte already supports this — it is what **Git Repo
Address** and **Auto Update** are for.

> **Read the warnings first.** Switching the panel into git mode makes it
> rebuild the server directory. `.env` and `data/bot.db` are deliberately not in
> the repo, so they are destroyed unless you save them first.

## This repo — already live

| | |
|---|---|
| Repository | <https://github.com/minoooooooooooo/tower-bot> |
| Visibility | public — so **no** username or token goes in the egg |
| Branch | `main` |
| Files tracked | 45 (code + docs; `.env`, `data/`, `dist/`, `node_modules/`, `.tools/` all ignored) |
| Pushed | 2026-10-31 |

Steps 1–2 of the migration below are done; **step 3 onwards still needs the
panel**, which is why they are waiting.

---

## How it works

| Egg field | Value | Effect |
|---|---|---|
| `Git Repo Address` | `https://github.com/<you>/<repo>.git` | where the code comes from |
| `Install Branch` | `main` | branch to clone |
| `User Uploaded Files` | `0` | **must be 0** — this is what enables the clone step. `1` tells the installer to skip it |
| `Auto Update` | `1` | `git pull` on every start |
| `Git Username` | your GitHub username | needed for private repos |
| `Git Access Token` | fine-grained PAT, *Contents: read* | needed for private repos; leave empty for a public repo |

On start the container runs, in order: `git pull` (if `.git` exists and
`AUTO_UPDATE=1`) → `npm install` (if `package.json` exists) → `node src/boot.js`.

## What is never in the repo

`.gitignore` already excludes:

- `.env` — your token. Recreate it by hand on the server.
- `data/` — the SQLite database. Re-upload your backup.
- `node_modules/`, `.tools/`, `dist/`

That is why the migration below is staged the way it is.

---

## Prerequisites

- A GitHub account. **Done** — `minoooooooooooo`.
- Git and the GitHub CLI, installed on the dev PC. **Done** — `Git 2.56.0`,
  `gh 2.103.3`, authenticated through the browser (no token in any file).
- Backup of the current server state: the `.env` contents (copy/paste) and
  `data/bot.db` (Files → Download). **Still outstanding** — needs the panel.

---

## Migration — do it in this order

**Step 1 — Save the server's secrets and data.**

- Panel → Files → open `.env` → copy the whole file into a local note.
- Stop the server → Files → `data/bot.db` → Download → keep it safe.
- Start the server again if you want it live while you prepare the repo.

**Step 2 — Create the repo and push. ✅ Done 2026-10-31.**

```powershell
git init -b main
git add -A
git commit -m "Initial commit"
gh repo create tower-bot --public --source . --remote origin --push
```

The result is <https://github.com/minoooooooooooo/tower-bot>. Verified before
pushing: 45 files staged, `.env` / `data/` / `dist/` / `node_modules/` absent
from the commit, and absent from the remote tree afterwards.

**Step 3 — Flip the panel to git mode.**

Edit the egg fields from the table above. `User Uploaded Files` **must** become
`0`, otherwise the installer keeps skipping the clone.

**Step 4 — Rebuild the server directory.**

Choose one:

- Panel **Reinstall** (if available) — cleanest: it wipes the directory and runs
  the install script, which clones the repo; or
- Files → delete everything in the server root, then **Restart**.

Either way the old upload is gone. That is expected — the repo replaces it.

**Step 5 — Recreate `.env`.**

After the clone, the server has code but no secrets. Files → New File → `.env` →
paste what you saved in step 1. The bot cannot start before this exists.

**Step 6 — Restore the database (optional, only if it held real data).**

Files → upload your `bot-YYYY-MM-DD.db` into `data/`, renamed to `bot.db`. If
you had no real birthdays yet, skip this — the bot creates a fresh database.

**Step 7 — Start and verify.**

```
INFO  [boot] Runtime Node 26.x.x
INFO  [bot] Loaded 5 command(s)
INFO  [bot] Logged in as ...
INFO  [bot] Registered 5 slash command(s) ...
```

If instead you see `Cannot find module 'discord.js'`, the clone happened but
`npm install` did not run — the startup command's `if [ -f package.json ]` check
failed, which means the repo root is wrong (the zip/folder was nested one level
too deep).

---

## The workflow after that

```powershell
git add -A
git commit -m "add games commands"
git push
```

Then press **Restart** in the panel (or wait for the next restart). `Auto Update`
pulls on start; there is no webhook, so a push does not restart the bot by
itself.

**Reminders that still apply:** `.env` stays on the server only; `data/bot.db` is
still yours to back up; the free tier still needs a login every two weeks.

## Rolling back

If a push breaks the bot, revert locally and push again:

```powershell
git revert HEAD
git push
```

Then restart. The panel's copy is only ever as good as `main`.

## If it goes wrong

Fall back to the upload flow, which is proven to work here:

1. Set `User Uploaded Files` back to `1` and clear `Git Repo Address`.
2. `package.bat` → upload `dist/bot.zip` → extract at the root.
3. Recreate `.env`, restart.

Nothing in the code depends on how it was deployed.
