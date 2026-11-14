# Tower Control Center (TCC)

TCC is an optional website layer provided by the site owner. It lets that
website read and control this bot: member lookups, moderation, embeds, ticket
settings, welcome/watch settings, logs, file transfer, deploys, database restore
and restart.

The integration is **additive**. With `TCC_URL` and `TCC_AGENT_SECRET` unset it
does nothing at all, and every existing slash and prefix command keeps working.

> **Only enable this if you trust the site owner.** The agent can write files in
> the bot folder, stage a deploy, restore the SQLite database and restart the
> process. Those are the features that make the control panel useful, and they
> are also the reason the secret must stay private.

## Files

| File | Purpose |
|---|---|
| `src/tcc/tcc-agent.mjs` | Outbound WebSocket agent, HMAC auth, file/deploy/DB/restart commands, boot guard |
| `src/tcc/adapter.js` | Bot-specific commands (moderation, tickets, settings, stats) and Discord permission checks |

`src/boot.js` calls `bootGuard()` before the bot opens its database, so a
staged restore or an automatic rollback of a failed deploy is applied on
startup. `src/index.js` calls `startTowerAgent(client)` after the commands and
events are loaded.

The agent opens **one outbound** `wss://` connection. No inbound port or domain
is needed, which is why it works on Wispbyte.

## Environment

Add these to `.env` **on the host** (never commit them):

```dotenv
TCC_URL=wss://...            # exact address from the site owner
TCC_AGENT_SECRET=...         # per-bot secret from the site owner
# TCC_RESTART_EXIT_CODE=1    # optional, default 1
```

- `TCC_URL` must start with `wss://`. Plain `ws://` is accepted for
  `localhost` / `127.0.0.1` only.
- `TCC_AGENT_SECRET` can be omitted if the panel writes `.tcc/agent.json`.
- Restart the bot after changing `.env`. The console prints
  `[tcc] Tower Control Center agent started ...` when the agent is active, and
  a warning if the values are present but invalid.
- `.tcc/` is runtime state (agent secret, staged restores) and is git-ignored.

## Deploying on Wispbyte

The code lives in GitHub; only `.env` and `data/` live on the host.

1. Commit and push this repository.
2. In Wispbyte, press **Restart** (with `AUTO_UPDATE` on, it pulls the commit).
3. Open the `.env` file in the panel and add the two values above.
4. Restart again and check the console for the `[tcc]` line.
5. Confirm on the website that the bot shows as online.

Do **not** upload the TCC zip over the repo. The zip's `src/index.js` and
`src/boot.js` are older than this repo's copies (they lack the ticket
rate-limit handling), so only the two `src/tcc/` files are taken from it.

## Security model (from the agent's own header)

- Mutual HMAC-SHA256 authentication with a per-bot secret.
- Commands are individually signed, timestamped and single-use (replay
  protection).
- Only registered commands exist; there is no shell, no `eval` and no
  arbitrary-code command.
- File access is jailed to the bot folder and refuses `.env`, keys,
  databases, `node_modules`, `.git` and `.tcc`.
- A broken agent must never take the bot down: startup is wrapped in
  `try/catch` in both `boot.js` and `index.js`.

## Turning it off

Remove `TCC_URL` and `TCC_AGENT_SECRET` from `.env` and restart. The files can
stay in place; they become inert. You can also delete `.tcc/` to clear any
staged state.

## Troubleshooting

| Symptom | Check |
|---|---|
| No `[tcc]` line | Both values set? `TCC_URL` starts with `wss://`? Restarted after editing `.env`? |
| `TCC_URL must be wss://` warning | Use the exact `wss://` address from the site owner |
| Agent starts but the site shows offline | Host outbound access to the TCC backend; secret matches the website |
| Bot loops or rolls back a deploy | `.tcc/deploy/state.json`; `bootGuard` rolls back after more than two unhealthy boots |
