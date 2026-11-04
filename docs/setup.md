# Setting up Helio on a new Windows laptop

Follow the parts in order. Each part ends with a check, so you know it worked
before moving on. Part 8 (the isolated runtime) is the hardened setup Helio
normally runs in; parts 1-7 are enough to run Helio directly in your own WSL
account.

Commands are run in the **Ubuntu (WSL) terminal** unless a step says
PowerShell. Nothing here copies credentials for you: you type secrets into one
file, `~/.config/helio/helio.env`, and nowhere else.

| Part | What | Time |
|---|---|---|
| 1 | Windows + WSL (Ubuntu 22.04, systemd) | 15 min |
| 2 | Base tools: git, Python 3.12, Bun, gh | 10 min |
| 3 | oh-my-openagent (`omo`) and herdr | 5 min |
| 4 | Projects: this repo and the EloBot checkout | 10 min |
| 5 | Dori skill and `dori` CLI | 2 min |
| 6 | Browser: Chrome profile and BrowserSkill | 10 min |
| 7 | Helio: `helio.env`, install, memory, first start | 15 min |
| 8 | Isolated runtime (root services, sandbox) | 30 min |

## 1. Windows and WSL

In **PowerShell as Administrator**:

```powershell
wsl --install -d Ubuntu-22.04
```

Reboot if asked, open "Ubuntu 22.04", and create your Linux user. The scripts
assume the distribution is named `Ubuntu-22.04` (the isolated launcher calls
`wsl.exe -d Ubuntu-22.04`).

Turn on systemd (needed for the isolated runtime's services):

```sh
printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf
```

Then in PowerShell: `wsl --shutdown`, and reopen Ubuntu.

**Check:** `systemctl is-system-running` prints `running` or `degraded` (not an error).

## 2. Base tools

```sh
sudo apt update
sudo apt install -y git curl unzip build-essential software-properties-common \
  bubblewrap slirp4netns iptables
# Python 3.12 (EloBot targets 3.12)
sudo add-apt-repository -y ppa:deadsnakes/ppa
sudo apt install -y python3.12 python3.12-venv
# Bun
curl -fsSL https://bun.sh/install | bash
# GitHub CLI
sudo apt install -y gh
```

Open a new terminal so `~/.bun/bin` is on `PATH`, then sign in to GitHub:
`gh auth login`.

**Check:** `python3.12 --version`, `bun --version`, `gh auth status` all succeed.

## 3. oh-my-openagent (omo) and herdr

omo is the coding agent every Helio session runs in. herdr is the terminal
multiplexer Dori uses to open, read and message sessions.

```sh
bun add -g omo-ai          # provides the `omo` command
omo                        # first run: sign in to your ChatGPT subscription, then exit
curl -fsSL https://herdr.dev/install.sh | sh
```

Helio only uses OpenAI models through the `chatgpt-subscription` provider; the
exact models are set in `helio.env` (part 7) and `omo/omo.jsonc`.

**Check:** `omo --version` and `herdr --version` print versions.

## 4. Projects

```sh
mkdir -p ~/PythonProjects && cd ~/PythonProjects
git clone <your private helio-agent remote> helio-agent
chmod 700 helio-agent                        # it contains private memory and docs
git clone https://github.com/jamestesting0/elo-bot.git elo-bot
cd elo-bot
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

Do not put a production `.env` into `elo-bot`: Helio's beta runs get their
credentials from `~/.dori/elobot/beta.env`, which is generated in part 7.

**Check:** `~/PythonProjects/elo-bot/.venv/bin/python -c "import discord, pymongo"` succeeds.

## 5. Dori skill and `dori` CLI

The Dori skill is vendored (and forked for Helio) in this repo. Register it with
omo and build the CLI from it:

```sh
cd ~/PythonProjects/helio-superagent
mkdir -p ~/.agents/skills
ln -s "$PWD/vendor/dori-mode" ~/.agents/skills/dori-mode
(cd vendor/dori-mode/scripts && bun install --frozen-lockfile && bun link)
```

This links the skill to this checkout: don't move or delete the checkout
afterwards. If `~/.agents/skills/dori-mode` or a `dori` command already exists,
inspect it before replacing it.

**Check:** `dori --help` lists `launch`, `watch`, `claim-done`;
`readlink -f "$(command -v dori)"` points into `~/PythonProjects/helio-superagent/vendor/`.

## 6. Browser: Chrome profile and BrowserSkill

Helio does live beta QA through a dedicated Chrome profile named Helio, driven
by the BrowserSkill extension (`bsk`).

1. Install BrowserSkill: put the `bsk` binary in `~/.local/bin/bsk` and the
   skill in `~/.pi/agent/skills/browser-skill` (follow BrowserSkill's own
   install instructions).
2. Install Chrome for the profile. Helio uses a private Chrome unpacked under
   `~/.local/share/helio-chrome/pkg` and launched by `isolation/bin/helio-chrome`:

   ```sh
   mkdir -p ~/.local/share/helio-chrome && cd ~/.local/share/helio-chrome
   curl -fLO https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
   dpkg-deb -x google-chrome-stable_current_amd64.deb pkg
   install -m 700 ~/PythonProjects/helio-superagent/isolation/bin/helio-chrome ~/.local/bin/helio-chrome
   helio-chrome     # sign in the QA Discord accounts and install the BrowserSkill extension
   ```

Never copy browser cookies from another machine; sign in fresh.

**Check:** `bsk --version` works and `helio-chrome` opens Chrome.

## 7. Helio

### 7a. The one configuration file

```sh
cd ~/PythonProjects/helio-superagent
python3 scripts/helio_config.py init      # creates ~/.config/helio/helio.env (mode 600)
nano ~/.config/helio/helio.env            # fill in the secrets; IDs are pre-filled
python3 scripts/helio_config.py check
```

Every setting is explained in [`helio.env.example`](../helio.env.example). The
required secrets are the Discord bot token, the beta bot token, the Clash of
Clans API login, the Helper API key and the restricted beta MongoDB URL.

If this laptop already has an older Helio (`~/.dori/elobot/env` exists), use
`init --from-installed` instead to copy its current values.

**Check:** `check` prints `helio.env OK`.

### 7b. Install

```sh
python3 scripts/install.py --profile owner              # preview
python3 scripts/install.py --profile owner --apply
(cd ~/.dori/discord-inbound && bun install --frozen-lockfile)
install -m 700 scripts/helio-host ~/.local/bin/helio     # the `helio` command
```

`--profile owner` is for your own WSL account; the isolated runtime (part 8)
uses `--profile isolated`. The installer writes `~/.dori/elobot/` and
`~/.dori/discord-inbound/`, generates the env, beta and permission files from
`helio.env`, and records a baseline so `helio update` works immediately. It
never overwrites an existing file.

**Check:** `helio update --preview` prints `Generated from helio.env: up to date`
and `Managed updates: none`.

### 7c. Memory

Restore the shared EloBot memory snapshot into a new omo identity. `memory/`
is not in git: copy it into the checkout from your encrypted backup first
(see [migration.md](migration.md)).

```sh
mkdir -p ~/.omo/memory/agents
python3 scripts/memory_snapshot.py restore \
  --source "$PWD/memory" \
  --destination ~/.omo/memory/agents/elobot-ec289b4c
```

See [migration.md](migration.md) for refreshing the snapshot on the old laptop first.

### 7d. Discord bot

Reuse the existing Helio bot (its token is in `helio.env`). Only if you need a
new bot: Discord Developer Portal -> New Application -> Bot -> enable the
Message Content intent -> Reset Token (into `helio.env`) -> OAuth2 URL with
`bot` scope and read/send/thread/reaction permissions -> invite it to the
EloBot server. Run `helio update` after changing the token.

### 7e. First start (direct, without isolation)

```sh
herdr --session elobot          # opens the private herdr session
~/.dori/elobot/start            # in the herdr pane: starts the Helio lead
```

The lead arms its monitors and greets you by Discord DM. Stop with `Ctrl+B`
then `Q` in herdr.

**Check:** you receive the greeting DM; `~/.dori/elobot/ack pending inbound` runs without errors.

## 8. Isolated runtime (recommended)

The isolated runtime runs Helio as a separate `helio-agent` Linux user inside a
bubblewrap sandbox with a firewall, so the agent cannot read your SSH keys,
production `.env`, or the beta/Oracle credentials. Two root services hold those
credentials and expose narrow sockets instead. Read
[architecture.md](architecture.md) first; this part needs `sudo`.

### 8a. Accounts and directories

```sh
sudo useradd --system --uid 999 --user-group --home-dir /nonexistent --shell /usr/sbin/nologin helio-agent
sudo useradd --system --uid 998 --user-group --home-dir /nonexistent --shell /usr/sbin/nologin helio-vault
sudo useradd --system --uid 997 --user-group --home-dir /nonexistent --shell /usr/sbin/nologin helio-release
sudo install -d -o helio-agent -g helio-agent -m 700 /var/lib/helio-agent/home
sudo install -d -o helio-vault -g helio-vault -m 700 /var/lib/helio-beta-service /var/lib/helio-beta-service/archive
sudo install -d -o helio-release -g helio-release -m 700 /var/lib/helio-release-service
sudo install -d -m 755 /var/lib/helio-runtime-policy
```

The UIDs matter: the launcher and service units reference 999.

### 8b. Service code and Python

```sh
sudo install -d -m 755 /opt/helio-beta-service/scripts /opt/helio-beta-service/packages
sudo python3.12 -m venv /opt/helio-beta-service/python
sudo /opt/helio-beta-service/python/bin/pip install --target /opt/helio-beta-service/packages pymongo dnspython certifi python-dotenv
cd ~/PythonProjects/helio-superagent/scripts
sudo install -m 644 helio-beta.py helio_beta_backup.py helio_beta_broker.py helio_beta_service.py \
  helio_beta_vault.py helio_isolated_launcher.py helio_release_service.py helio_approval.py \
  helio_isolated_admin.py helio_deploy_plan.py helio_owner_policy.py helio_state_backup.py /opt/helio-beta-service/scripts/
```

The services need a Python 3.12 outside `/home` (they run with `ProtectHome`).
The current laptop uses a standalone CPython build copied to
`/opt/helio-beta-service/python`; a venv as above works the same way.

### 8c. Credentials (root-only)

```sh
sudo install -d -m 750 -g helio-vault /etc/helio-beta-service
sudo install -d -m 750 -g helio-release /etc/helio-release-service
sudoedit /etc/helio-beta-service/credential.env     # MONGO_DB_URL=<same value as HELIO_BETA_MONGO_URL>
sudoedit /etc/helio-beta-service/exclusions.json    # protected beta records; [] if none
sudoedit /etc/helio-release-service/ssh_config       # Host elo-bot ... IdentityFile /etc/helio-release-service/id_ed25519
# copy the Oracle SSH key to /etc/helio-release-service/id_ed25519 (owner helio-release, mode 600)
```

`/etc/helio-release-service/auth.json` is written by the launcher from your
owner files on every launch; you don't create it.

### 8d. Services and host commands

```sh
cd ~/PythonProjects/helio-superagent
sudo install -m 644 isolation/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now helio-beta-maintenance.service helio-release.service
install -m 700 isolation/bin/helio-backup ~/.local/bin/helio-backup
```

### 8e. The isolated home

Inside the sandbox the isolated home is mounted as `/home/james`, with its own
copy of this project at `~/helio-agent`, its own EloBot checkout, `.dori`,
omo login, browser profile and memory. Seed it once from your owner home:

```sh
sudo rsync -a --exclude .git ~/PythonProjects/helio-superagent/ /var/lib/helio-agent/home/helio-agent/
sudo rsync -a ~/PythonProjects/elo-bot/ /var/lib/helio-agent/home/PythonProjects/elo-bot/ --exclude .env
sudo rsync -a ~/.bun ~/.local ~/.agents ~/.pi /var/lib/helio-agent/home/
sudo chown -R helio-agent:helio-agent /var/lib/helio-agent/home
```

Then open the sandbox shell and install inside it, so every path is rendered
from the sandbox's point of view:

```sh
helio                                            # opens the isolated herdr workspace
python3 ~/helio-agent/scripts/install.py --profile isolated --apply
(cd ~/.dori/discord-inbound && bun install --frozen-lockfile)
ln -sfn ~/helio-agent/vendor/dori-mode ~/.agents/skills/dori-mode
install -m 700 ~/helio-agent/scripts/helio-wsl ~/.local/bin/helio
```

Restore memory inside the sandbox the same way as 7c.

**Check:** from your normal shell, `helio --check` prints
`Isolated runtime basic checks passed.` and `helio status` shows both services running.

### 8f. Start

```sh
helio start      # new lead session in the isolated workspace
helio resume     # reopen the latest lead session
```

Day-to-day operation and updates: [workflow.md](workflow.md).

## What this guide does not automate

- The Discord bot, GitHub access, ChatGPT login, Chrome sign-ins and the Oracle
  SSH key are yours to create or sign in to; no script handles them.
- Part 8 is a documented manual procedure, captured from the running setup.
  There is no single provisioning script for the root-owned pieces yet.
