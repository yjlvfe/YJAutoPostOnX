# YJAutoPostOnX

Source-only repository containing two components for automated X (Twitter) content generation and scheduled publishing:

- **`Appimage/`** — Electron desktop application for AI-assisted tweet generation, CSV workflow/queue management, profile lifecycle management, and Playwright-based X automation.
- **`Bot/`** — Node.js Telegram control bot backed by PostgreSQL persistence, an isolated Python direct-X protocol bridge, and an optional Docker VPN SOCKS5 proxy container.

## Repository Layout

```text
.
├── Appimage/
│   ├── dev/
│   │   ├── main.js               # Electron main-process entry point
│   │   ├── preload.js            # Context-isolated preload bridge
│   │   ├── automation/           # Content engine, queue, session & X automation modules
│   │   ├── config/               # Provider model configuration (providers.json)
│   │   ├── security/             # Config validation, migration & static security audit
│   │   ├── ui/                   # Desktop renderer HTML/CSS/JS
│   │   └── utils/                # Atomic JSON, logging & fatal error helpers
│   ├── vendor/                   # Vendored puppeteer-extra-plugin-user-data-dir
│   ├── package.json
│   └── LICENSE
├── Bot/
│   ├── src/
│   │   ├── index.js              # Bot composition root & CLI/service entry point
│   │   ├── runner.js             # Publishing loop, scheduling, rotation & shutdown
│   │   └── ...                   # PostgreSQL storage, Telegram UI/API, queue & bridge modules
│   ├── python/
│   │   ├── direct_x_bridge.py    # Isolated direct-X JSON-line bridge
│   │   └── direct_x_compat.py    # Dependency version pins & failure classification
│   ├── docker/
│   │   ├── Dockerfile.vpn        # Optional VPN + SOCKS5 proxy container image
│   │   └── *.sh                  # Container entrypoint & healthcheck scripts
│   ├── systemd/                  # Service unit and launcher templates
│   ├── package.json
│   ├── requirements-direct-x.txt
│   └── LICENSE
├── Readme.md
└── license.md
```

## Prerequisites

- **Node.js `>= 22`** (required by both `Appimage/package.json` and `Bot/package.json`) and `npm`
- **PostgreSQL** (required storage backend for `Bot/`)
- **Python 3** with an isolated virtual environment for `Bot/requirements-direct-x.txt`
- **Electron** (`Appimage/` devDependency, installed via `npm ci` / `npm install` inside `Appimage/`)
- **Docker** (optional, for building/running the `Bot/docker/Dockerfile.vpn` proxy container)

## Safe Entry Points & Setup Overview

> **Note:** Automated test suites are omitted from this source-only repository. All runtime secrets, credentials, cookies, databases, and environment files live externally outside the repository.

### `Appimage/` (Desktop Application)

Install dependencies inside `<APPIMAGE_DIR>`:

```bash
cd <APPIMAGE_DIR>
npm ci
```

Primary entry points and safe local scripts:

- `Appimage/dev/main.js` — Electron main-process entry point (`npm start` runs `electron .`)
- `npm run audit` — Runs the static security auditor (`Appimage/dev/security/auditor.js`)
- `npm run build:linux` — Packages the Linux AppImage via `electron-builder`

### `Bot/` (Telegram Bot & Direct-X Bridge)

1. Install Node.js dependencies (`pg`) inside `<BOT_DIR>`:

   ```bash
   cd <BOT_DIR>
   npm ci
   ```

2. Create a dedicated Python virtual environment and install pinned bridge dependencies from `Bot/requirements-direct-x.txt`:

   ```bash
   python3 -m venv <BOT_DIR>/.venv-direct-x
   <BOT_DIR>/.venv-direct-x/bin/pip install -r <BOT_DIR>/requirements-direct-x.txt
   ```

3. Provision PostgreSQL (`<DB_NAME>`, `<DB_USER>`) and supply runtime configuration externally outside version control.

Primary entry points:

- `Bot/src/index.js` — Main Node.js entry point (requires `STORAGE_BACKEND=postgres`, validates configuration via `Bot/src/env.js`, and starts `Bot/src/runner.js`)
- `Bot/python/direct_x_bridge.py` — Standalone JSON-line bridge spawned by `Bot/src/directX.js` with `python -I -u`
- `Bot/systemd/` — Service unit and launcher templates (`telegram-bot-launcher.sh` expects a strict `0400`/`0600` `.env.local` in `<BOT_DIR>`)
- `Bot/docker/Dockerfile.vpn` — Optional Docker image definition for an isolated VPN SOCKS5 proxy container

## External Runtime Configuration & Secrets

This repository does **not** include `.env*` files, database dumps, SQLite state, secret token files, account cookies, or runtime data directories. Operators supply these externally on the host:

- `<BOT_DIR>/.env.local` (restricted mode `0400` or `0600`) for bot tokens and authorized Telegram IDs (`TELEGRAM_BOT_TOKEN`, `BOT_OWNER_ID`, `BOT_OWNER_CHAT_ID`, `BOT_ALLOWED_USER_IDS`, `BOT_ALLOWED_CHAT_IDS`, `BOT_DATA_DIR`)
- PostgreSQL connection settings and secret files (`PGHOST`, `PGPORT`, `PGUSER=<DB_USER>`, `PGDATABASE=<DB_NAME>`, `PGPASSWORD` or `PG_PASSWORD_FILE`)
- Optional VPN token file (`NORDVPN_TOKEN` or `NORDVPN_TOKEN_FILE`) and `DIRECT_X_PYTHON` path pointing to the bridge interpreter
- External `<DATA_DIR>` for account cookies, imports/exports, and operational state

## License

Licensed under the MIT License. See [license.md](license.md) for details and third-party notices.
