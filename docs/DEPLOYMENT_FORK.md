# Deploying the TaskNebula Fork Build

This guide covers deploying the **separate Docker build** of the TaskNebula
fork — the image published on Docker Hub as `nsneo/tasknebula` (in contrast
to the upstream `neuraparse/tasknebula`).

> **Compatibility:** anything in the upstream guides
> (`docs/DEPLOYMENT.md`, `docs/RELEASE.md`, `README.md`) that talks about
> `neuraparse/tasknebula` applies unchanged — just replace the image name with
> `nsneo/tasknebula` and the pinned tag with `v0.15.1` (or newer fork tags).

## 1. Published artifacts

| Artifact | Location |
| --- | --- |
| Docker image | `docker.io/nsneo/tasknebula:0.15.1` (linux/amd64, standalone Next.js output) |
| Source | GitHub fork `nsneo-iv/taskNebula`, tag `v0.15.1` |
| Version | 0.15.1 (root `package.json` is the single source of truth) |

The runtime image:

- runs **DB migrations on start** (`docker-entrypoint.sh` → `pnpm db:migrate:prod`),
- seeds demo data **only** when `SEED_DEMO_DATA=true` **and** `SKIP_SEED != true`
  (default: skip; first-time setup happens via the `/setup` flow),
- serves on port **3000**, health at `GET /api/health` (readiness
  `GET /api/ready`, metrics `GET /api/metrics`),
- keeps two volumes with operator data: `uploads_data` (files) and
  `backups_data` (self-update/rollback backups).

## 2. Option A — full stack with Docker Compose (recommended)

Use the repository compose stack (Postgres + Redis + LiveKit + web). Docker
Compose on a fresh host:

```bash
git clone https://github.com/nsneo-iv/taskNebula.git
cd taskNebula
cp .env.example .env      # then fill in the values below
```

Required variables (compose fails fast with `:?... must be set` if missing):

```bash
# Auth — generate with: openssl rand -base64 32
AUTH_SECRET=...

# Redis (compose refuses to start without a password)
REDIS_PASSWORD=...

# LiveKit (voice rooms) — any random value in a single-host deploy
LIVEKIT_API_SECRET=...

# App origin — must match the browser URL and AUTH_URL
APP_URL=https://tasknebula.example.com
```

Then start the fork build:

```bash
TASKNEBULA_IMAGE=nsneo/tasknebula:0.15.1 docker compose up -d
```

`docker-compose.yml` keeps `neuraparse/tasknebula:latest` as the default and
the `image:` line is overridden purely via `TASKNEBULA_IMAGE`, so the fork
image is used for the `web` service while Postgres/Redis/LiveKit come from the
compose file. The web container publishes on `127.0.0.1:${PORT:-3000}`.

### Desktop variant

`docker-compose.desktop.yml` is the single-machine quick start and already
pins `v0.15.1` (of the upstream image). To run the fork build instead:

```bash
TASKNEBULA_IMAGE=nsneo/tasknebula:0.15.1 docker compose -f docker-compose.desktop.yml up -d
```

## 3. Option B — bare `docker run` (web only, DB/Redis external)

```bash
docker run -d --name tasknebula-web \
  -p 127.0.0.1:3000:3000 \
  -e NODE_ENV=production \
  -e APP_URL=http://localhost:3000 \
  -e AUTH_URL=http://localhost:3000 \
  -e NEXT_PUBLIC_APP_URL=http://localhost:3000 \
  -e DATABASE_URL=postgresql://tasknebula:password@host:5432/tasknebula \
  -e REDIS_URL=redis://:password@redis-host:6379 \
  -e AUTH_SECRET="$(openssl rand -base64 32)" \
  -v tasknebula_uploads:/app/uploads \
  -v tasknebula_backups:/app/backups \
  nsneo/tasknebula:0.15.1
```

Migrations run automatically at container start; watch the first start with
`docker logs -f tasknebula-web` until `/api/health` returns 200.

## 4. Sign-in: OIDC and Active Directory (SSO)

Instance-level SSO is controlled by environment variables; credentials are
**never baked into the image**.

OpenID Connect (Entra ID, Okta, Keycloak, ...):

```bash
OIDC_ENABLED=true
OIDC_ISSUER=https://idp.example.com/realms/corp
OIDC_CLIENT_ID=tasknebula
OIDC_CLIENT_SECRET=...
OIDC_NAME=Corp SSO          # label shown on the sign-in button
```

Windows AD / LDAP:

```bash
AD_ENABLED=true
AD_LDAP_URL=ldap://dc.corp.example.com:389   # or ldaps://
AD_LDAP_SEARCH_BASE=DC=corp,DC=example,DC=com
# Optional
# AD_LDAP_BIND_DN=CN=svc-tasknebula,OU=Service Accounts,DC=corp,DC=example,DC=com
# AD_LDAP_BIND_PASSWORD=...
# AD_LDAP_USER_FILTER=(&(objectClass=user)(|(sAMAccountName={{username}})(userPrincipalName={{username}})))
# AD_LDAP_REQUIRED_GROUP=CN=TaskNebula Users,OU=Groups,DC=corp,DC=example,DC=com
# AD_LDAP_MAIL_ATTRIBUTE=mail
# AD_LDAP_NAME_ATTRIBUTE=displayName
# AD_EMAIL_DOMAIN=corp.example.com
# AD_AUTO_PROVISION=true
```

With OIDC and/or AD enabled the sign-in window shows **Email | SSO | AD**
tabs. The **SSO settings section** (Workspace → Settings → SSO) additionally
stores per-workspace OIDC/AD configuration (display name, issuer, client ID,
client secret; LDAP URL, domain, bind DN, bind password) in the database
(`organizations.settings` → `ssoOidc` / `ssoAd`) and reflects instance
availability from the environment.

## 5. First start

1. `docker compose up -d` (or `docker run`), wait for health:
   ```bash
   curl -fsS http://localhost:3000/api/health
   ```
2. Open `http://localhost:3000` — with a fresh database the `/setup` flow
   creates the first admin; after that, sign in and create the first
   workspace, or sign in via OIDC/AD if configured.
3. OAuth callback URLs (if GitHub/Google sign-in is enabled):
   `https://yourdomain.com/api/auth/callback/github` and
   `.../callback/google`.

## 6. Upgrade and rollback

Upgrade (image pulls, migrations run on start):

```bash
TASKNEBULA_IMAGE=nsneo/tasknebula:<new-tag> docker compose up -d
```

Rollback (pin a previous tag, no rebuild):

```bash
./scripts/tasknebula-backup.sh                                    # backup first
TASKNEBULA_IMAGE=nsneo/tasknebula:0.15.0 docker compose up -d
```

Backup/restore tooling lives in `scripts/tasknebula-backup.sh` (Postgres
custom-format archive + uploads archive + checksums).

## 7. Troubleshooting

| Symptom | Check |
| --- | --- |
| Container restarts at start | `docker logs tasknebula-web` — most likely `AUTH_SECRET`, `DATABASE_URL` or `REDIS_URL` misconfigured; migrations must succeed once |
| Health check never passes | `GET /api/health` — the container waits for Postgres/Redis; verify `DATABASE_URL`/`REDIS_URL` hostnames resolve inside the compose network |
| 307 loop to `/auth/signin` | `APP_URL`/`AUTH_URL` mismatch with the browser URL (cookie scope) |
| SSO tab missing | `OIDC_ENABLED=true` + issuer/client set, or `AD_ENABLED=true` + LDAP URL/search base set; see §4 |