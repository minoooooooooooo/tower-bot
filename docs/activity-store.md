# Store Activity (optional Discord Activity storefront)

`/store` works entirely inside Discord messages. This adds an **optional**
embedded Activity — a full-screen dark storefront opened from an **Open store**
button — on top of the same catalogue, balances and purchase engine. Nothing in
this document is required for the bot to run: with `ACTIVITY_ENABLED` unset the
HTTP server never starts and `/store` behaves exactly as before.

## What it is

| Piece | File |
|---|---|
| HTTP server, static files, API routing, CSP | `src/activity/server.js` |
| OAuth exchange, guild/member auth, storefront shape | `src/activity/store-api.js` |
| Client shell / theme / logic | `src/activity/public/index.html`, `styles.css`, `app.js` |
| Bundled Embedded App SDK (no CDN) | `src/activity/public/vendor/discord-sdk.js` |
| Optional free tunnel (`TUNNEL_ENABLED=1`) | `src/activity/tunnel.js` |
| Optional channel post of the address (`ACTIVITY_URL_CHANNEL_ID`) | `src/activity/announce.js` |

The Activity reuses `src/services/store.js`, so prices, per-guild overrides,
limits, immediate delivery and refunds are identical to the message commands.
There is no second source of truth.

## Requirements

1. An **HTTPS** URL with a valid certificate that Discord can iframe. Plain HTTP
   will not work, and neither will a self-signed certificate. `TUNNEL_ENABLED=1`
   provides one for free (Option A below), so a panel without inbound ports and
   without a domain is fine.
2. The bot must listen on a port the public URL forwards to: either directly
   (Option B) or through the tunnel the bot runs itself (Option A).
3. `CLIENT_ID` (already required for slash commands) and the **OAuth2 client
   secret** from the Developer Portal.

## 1. Enable it in the Developer Portal

1. <https://discord.com/developers/applications> → your application.
2. **Activities** → **Settings** → enable Activities.
3. **Activities → URL Mappings**: add the prefix `/` and point it at your public
   URL, e.g. `https://store.example.com`. The client requests everything through
   `/.proxy/...`, and `src/activity/server.js` strips that prefix, so one mapping
   for `/` is enough.
4. **Activities → Settings → Entry Point Command**: create the entry-point
   command (it appears as `/launch` by default). This is the command Discord uses
   to start the Activity from the app's profile; keep it enabled.
5. **OAuth2** → copy the **Client Secret** (`Reset Secret` if you never saved it)
   into `DISCORD_CLIENT_SECRET`.

The bot never asks for a redirect URI: the Activity's `authorize()` call returns
a one-time `code`, and the bot swaps it for a token server-side.

## 2. Configure the bot

```ini
ACTIVITY_ENABLED=1
DISCORD_CLIENT_SECRET=...          # OAuth2 tab, never commit this
TUNNEL_ENABLED=1                   # free public HTTPS address, no domain needed
# ACTIVITY_URL_CHANNEL_ID=123...   # optional: post the new address in a channel
# ACTIVITY_PUBLIC_URL=https://store.example.com   # only with your own host
# ACTIVITY_PORT=3000               # default
# ACTIVITY_HOST=0.0.0.0            # default; 127.0.0.1 behind a local proxy
```

Restart the bot. The log prints `Store activity listening on …`, and with the
tunnel on, a `[tunnel] Store activity public URL: https://…trycloudflare.com`
line a few seconds later. `/store` then gains the **Open store** button; the
plain-text `/store buy` flow still works.

If `ACTIVITY_ENABLED=1` but the client id or secret is missing, the bot logs a
warning and stays up with the Activity turned off. It never crashes over this.

## 3. Put HTTPS in front of it

Discord requires HTTPS on 443 (behind a proxy) for the iframe. Three setups, in
order of least effort:

### Option A: let the bot run its own tunnel (free, no domain)

Set `TUNNEL_ENABLED=1` next to the other activity values and restart:

```ini
ACTIVITY_ENABLED=1
DISCORD_CLIENT_SECRET=...
TUNNEL_ENABLED=1
```

The bot downloads Cloudflare's tunnel client once (about 35 MB) into
`data/tunnel/` and runs it against its own port. No account, no card, no domain,
no inbound ports — it works from a panel that only allows outbound connections.
The log then prints:

```
[tunnel] Store activity public URL: https://calm-river-1234.trycloudflare.com
```

The same value is written to `data/tunnel-url.txt`, so you can read it from the
panel's file manager if the console scrolled. Use it as the portal **Target**.

**Getting the new address without opening the panel:** set
`ACTIVITY_URL_CHANNEL_ID` to a channel id and the bot posts the address there on
every start in a code block, so copying it gives exactly the value the portal
needs (no trailing slash), along with a one-line reminder of where to paste it:

```ini
ACTIVITY_URL_CHANNEL_ID=123456789012345678
```

It needs **View Channel** and **Send Messages** in that channel (the bot's
normal permissions are enough). A wrong id, a missing permission or a deleted
channel only logs a warning; nothing else is affected. This is off by default,
and only fires when the bot's own tunnel provides the address.

Two things to know:

- The address is tied to the running process. It **changes when the bot
  restarts** — update the URL mapping afterwards. Nothing else needs touching.
- A brand-new address can take a minute or two before DNS answers. If the portal
  rejects it, wait and save again; `curl` the `/healthz` until it returns JSON.

If the download or the process fails (a host that blocks it, an unsupported
architecture), the bot logs a warning and carries on; no command is affected.
This machine runs Linux x64 or Windows x64; other platforms report "no build"
and stay off.

### Option B: Caddy on the same host (automatic certificates)

```caddyfile
store.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Then run the bot with `ACTIVITY_HOST=127.0.0.1` so the port is not public.

**Docker Compose**: uncomment the published port and keep the container on the
host network bridge:

```yaml
ports:
  - "127.0.0.1:3000:3000"
```

**Oracle Cloud**: open 443 (and 80 for certificate validation) in the VCN
security list *and* in the instance's `iptables`/`ufw` — the image ships with
host rules that drop those ports even when the VCN allows them. See
[`deploy-oracle.md`](deploy-oracle.md).

### Option C: a manually run tunnel

Same idea as Option A, but outside the bot — useful when the host blocks the
download, or when you want a named tunnel with your own domain:

```bash
cloudflared tunnel --url http://127.0.0.1:3000        # quick, free, random URL
cloudflared tunnel run --token <named-tunnel-token>   # stable hostname + domain
```

The quick tunnel keeps a long-lived **outbound** connection, so no ingress rule
is needed. A named tunnel needs a domain in a Cloudflare account, but gives a
fixed address that never changes.

## 4. Verify

```bash
curl https://store.example.com/healthz      # {"ok":true,"activity":true}
curl -I https://store.example.com/           # text/html, CSP with frame-ancestors
```

Then in Discord: `/store` → **Open store**. First open shows the boot screen,
then the card grid. `/store` in a DM has no guild, so the Activity replies
"Open the store from a server".

### Demo mode without Discord

`https://store.example.com/?demo=1` renders the storefront with mock data and no
OAuth. It is for checking layout and theme changes; purchases are disabled and
say so. You can also open the static files from a local HTTP server — the client
only needs the API for the non-demo path.

## API

All routes are served from the same origin (Discord proxies them under
`/.proxy`). JSON in, JSON out.

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/config` | none | `{ enabled, client_id, activity_url }` |
| `POST /api/token` | none | Exchanges the SDK `code`; returns `{ access_token, expires_in }` |
| `GET /api/store?guildId=` | Bearer | Balance, items, full background collection |
| `POST /api/buy` | Bearer | Charges and delivers one item |
| `POST /api/equip` | Bearer | Equips an owned/unlocked background |
| `GET /healthz` | none | Liveness probe |

The Bearer token is the member's OAuth access token; `store-api.js` validates it
against `GET https://discord.com/api/users/@me` (cached 5 minutes) and then
checks that the bot is in the guild and the caller is still a member (cached 1
minute). Guilt by guild id alone is never trusted.

`POST /api/buy` accepts `{ guildId, key, quantity, name, color, image, imageName }`.
`image` is a `data:` URL (PNG/JPEG/WebP/GIF, 256 KB max) that the server turns
into a `Buffer` before handing it to the purchase engine; uploads are checked
before any coins are taken, and a delivery failure still refunds.

## Security notes

- The client secret never leaves the bot process; the browser only sees a
  short-lived access token.
- `Content-Security-Policy` allows framing only by Discord domains
  (`frame-ancestors`), and scripts/images only from this origin plus Discord's
  CDN. There are no CDN script tags: the Embedded App SDK is bundled at
  `src/activity/public/vendor/discord-sdk.js`.
- Bodies are capped at 2 MB, static paths are normalised and confined to
  `src/activity/public`, `assets/profile/backgrounds` and the single
  `assets/profile/coin.png` mark, and no route writes files outside `data/`.
- The API mutates coins only through `buyStoreItem`, so all the existing checks
  (limits, enabled, price overrides, atomic charge) apply unchanged.

## Updating the bundled SDK

The bundle is committed, so production needs no build step and no dev
dependencies. After bumping `@discord/embedded-app-sdk`:

```bash
npm install
npm run build:activity     # rewrites src/activity/public/vendor/discord-sdk.js
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| "The store activity is not enabled for this bot yet." | `ACTIVITY_ENABLED` unset, or `CLIENT_ID`/`DISCORD_CLIENT_SECRET` missing. Check the startup log. |
| Blank iframe / "refused to connect" | The URL is HTTP, the certificate is invalid, or the portal mapping points somewhere else. Check the browser console in the Activity (right-click → Inspect). |
| `invalid_origin` from `/api/token` | The request reached the server through a host the portal does not map (open the store from Discord, not a bare browser tab). |
| Bot in the guild but "You are not a member" | The member cache (1 minute) still holds an old state, or the user is not actually in that guild. Reopen after a minute. |
| `/.proxy` paths 404 | Missing `/` URL mapping in the Developer Portal. |
| Images missing in the Activity | The design's file is missing from `assets/profile/backgrounds/`, or `assets/profile/coin.png` was not deployed (only the coin pills/wallet are affected). |
| No `Store activity public URL` line | `TUNNEL_ENABLED` unset, the activity server is off, or the 35 MB download failed — check the warning just above it. |
| Portal rejects the tunnel address | A fresh `trycloudflare.com` name can take a minute or two to resolve. Wait, then save again. |
| Activity broke after a restart | The tunnel address changed. Copy the new one from the channel message, the log or `data/tunnel-url.txt` into the URL mapping. |
| The address was not posted in the channel | `ACTIVITY_URL_CHANNEL_ID` unset or wrong, the bot lacks View Channel / Send Messages there, or the channel is not text. The warning above the activity log names the reason. |
