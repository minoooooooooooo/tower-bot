# Deploying to Oracle Cloud Always Free

This bot is designed to run as a single Docker container, which is exactly what a small always-on VM wants.

## Reality check: idle reclamation

Oracle may reclaim Always Free instances it considers idle. Per their docs, an instance is idle when **all** of these are true over a 7-day window:

- CPU utilization at the 95th percentile is under **20%**
- Network utilization is under **20%**
- Memory utilization is under **20%** (A1 shapes only)

A quiet Discord bot sits near zero on all three, so it is a plausible reclamation target. There is no guaranteed workaround, and artificial CPU burners do not help with the network or memory criteria. Practical guidance:

- Prefer the **AMD micro** shape: the memory rule does not apply and 1 GB is plenty for this bot.
- Keep everything reproducible. The entire deployment is `Dockerfile` + `docker-compose.yml` + `.env`, so a rebuild takes about five minutes.
- Do not store anything on the VM you cannot recreate.
- Optionally co-locate something genuinely useful (a status page, a monitoring agent) to raise utilization.
- Enforcement is inconsistent in practice — many idle instances run for years. Treat it as "probably fine, but be ready to rebuild", not as a guarantee.

## Step 1: account

1. Sign up at <https://cloud.oracle.com> and complete card verification (Always Free resources are not charged).
2. Choose your **home region** carefully — it cannot be changed later, and Always Free resources only exist there. Pick the region closest to you.
3. Wait for the account to finish provisioning.

## Step 2: create the VM

Console → **Compute** → **Instances** → **Create instance**.

- **Image:** Canonical Ubuntu 24.04
- **Shape:** Change shape →
  - **Ampere / VM.Standard.A1.Flex**, 1 OCPU / 6 GB (better if you plan heavier features), or
  - **AMD / VM.Standard.E2.1.Micro**, 1/8 OCPU / 1 GB (simplest for this bot)
- **Boot volume:** 50 GB (default)
- **SSH keys:** generate a new key pair and download the private key, or paste your own public key
- **Public IPv4 address:** assign one

If you get **"Out of host capacity"**, try another availability domain, retry later, or fall back to the AMD micro shape, which is usually easier to obtain.

## Step 3: networking

Nothing to open. The bot only makes **outbound** connections, so the default security list (SSH on port 22 only) is correct. Do not add ingress rules for 80/443.

## Step 4: connect

```bash
ssh -i C:\path\to\your-key.pem ubuntu@<public-ip>
```

- Ubuntu images use the `ubuntu` user; Oracle Linux images use `opc`.
- If Windows rejects the key with a permissions error, run:
  ```powershell
  icacls C:\path\to\your-key.pem /inheritance:r /grant:r "$env:USERNAME:R"
  ```

## Step 5: install Docker

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker
sudo systemctl enable --now docker
docker --version
docker compose version
```

`systemctl enable` matters: it is half of what brings the bot back after a reboot. The other half is `restart: always` in the compose file.

## Step 6: upload the project

On Windows, from the project folder:

```powershell
.\package.bat
scp -i C:\path\to\your-key.pem dist\bot.zip ubuntu@<public-ip>:~/
```

`package.bat` wraps `scripts\package.ps1` with an execution-policy bypass, which this machine needs. The zip deliberately excludes `node_modules`, `.tools`, and `.env`.

On the server:

```bash
sudo apt install -y unzip
mkdir -p ~/discord-bot && cd ~/discord-bot
unzip -o ~/bot.zip
```

If you later put the project in a Git repo, `git clone` works just as well.

## Step 7: create `.env` on the server

```bash
cd ~/discord-bot
nano .env
```

Paste the same values as your local `.env`, then lock down permissions:

```bash
chmod 600 .env
```

Birthdays and settings are stored in SQLite inside the `bot-data` Docker volume, so they survive rebuilds and reboots. The volume is created automatically on first start.

## Step 8: start it

```bash
docker compose up -d --build
docker compose logs -f
```

`Ctrl+C` stops following the logs; the container keeps running. Verify with `docker compose ps` — status should be `Up`.

## Step 9: prove it survives a reboot

```bash
sudo reboot
```

Reconnect after a minute and run `docker compose ps` in `~/discord-bot`. It should be `Up` again without you starting anything.

## Step 10: updating the bot

```powershell
.\package.bat
scp -i C:\path\to\your-key.pem dist\bot.zip ubuntu@<public-ip>:~/
```

```bash
cd ~/discord-bot
unzip -o ~/bot.zip
docker compose up -d --build
```

Compose rebuilds the image and recreates the container only when something changed.

## Operations cheat sheet

| Task | Command |
|---|---|
| Follow logs | `docker compose logs -f --tail=100` |
| Restart | `docker compose restart` |
| Stop | `docker compose down` |
| Shell inside container | `docker compose exec bot sh` |
| Resource usage | `docker stats` |
| Disk space | `df -h` |
| Free disk from old images | `docker system prune -af` |
| Back up the database | `docker compose stop bot && docker compose cp bot:/app/data/bot.db ./bot-backup.db && docker compose start bot` |
| Restore the database | `docker compose stop bot && docker compose cp ./bot-backup.db bot:/app/data/bot.db && docker compose start bot` |

**Warning:** `docker compose down -v` deletes the `bot-data` volume, which erases every birthday and setting. Use plain `docker compose down` when you only want to stop the bot.

Run a backup before updating the bot, and copy `bot-backup.db` off the VM occasionally. A VM is replaceable; your members' birthdays are not.

## Troubleshooting

**`Used disallowed intents` in the logs** — enable **Message Content Intent** in the Developer Portal (Bot → Privileged Gateway Intents), then `docker compose restart`.

**`Invalid token`** — the token was reset or copied incorrectly. Re-copy it into `.env`, then `docker compose restart`.

**Build fails or the process is killed on a 1 GB micro** — add swap:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**Container restarting in a loop** — `docker compose logs --tail=50` will show the real error, usually a missing env var.

**Slash commands missing** — set `GUILD_ID` in `.env` and restart for instant registration. Global commands can take up to an hour.

## Staying inside the free tier

- Compute: 2 AMD micro instances **or** 2 OCPU / 12 GB of A1 total — not both at full size.
- Block storage: 200 GB total across all boot and block volumes.
- Egress: 10 TB/month.
- Never pick a paid shape, and check **Governance & Administration → Limits, Quotas and Usage** if unsure.
