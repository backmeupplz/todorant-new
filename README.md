# Todorant vNext

A compact, realtime, local-first todo manager. The repository is a pnpm
TypeScript monorepo containing the Preact client, Fastify API, shared sync
domain, PostgreSQL migrations, and deployment configuration.

## Local development

Requirements: Node 24+, pnpm 11+, and PostgreSQL 18.

```sh
corepack enable
docker compose up -d postgres
pnpm install --frozen-lockfile
cp .env.example .env
pnpm db:migrate
pnpm dev
```

The web client runs at `http://localhost:5173` and proxies `/api` and `/ws` to
the API at `http://localhost:3000`.

## Quality gates

The self-hosted GitHub workflow runs the same repository-wide command used
locally:

```sh
pnpm validate
```

It covers lint, type checking, unit/integration tests, production builds,
database migration consistency, and the 45 KB gzip initial-JavaScript budget.
The dedicated runner additionally starts a disposable PostgreSQL 18.4 container,
applies every migration, and runs the PostgreSQL/REST/WebSocket integration suite.
Run the same persistence proof locally with Podman, or with local PostgreSQL 18 tools:

```sh
CONTAINER_ENGINE=podman scripts/container-integration.sh
PG_BIN="$(brew --prefix postgresql@18)/bin" scripts/postgres-integration.sh
```

## Deployment

Create three Easypanel services: PostgreSQL 18.4, API, and web. The local Compose
file pins the official multi-architecture 18.4 Alpine image digest and mounts
the PostgreSQL 18 versioned data parent at `/var/lib/postgresql`. Use
`apps/api/nixpacks.toml` for the API and `apps/web/nixpacks.toml` for the static
web service. Set the API environment from `.env.example`, use a unique session
pepper, and give `LEGACY_MONGO_URL` a database user restricted to `find` and
`listCollections`. The API also rejects legacy URLs that are not explicitly
marked read-only.

Set the web service's `API_UPSTREAM` to the private Easypanel API service URL.
The committed Caddyfile serves the SPA and proxies same-origin `/api/*` and `/ws`
requests, including WebSocket upgrades. Route `new.todorant.com` only to this web
service. Cloudflare must use Full (strict) TLS.
Runtime credentials and the production legacy connection are deployment-owner
configuration and are never committed.

GitHub Actions runs only on the repository-scoped runner labels
`self-hosted`, `macOS`, `ARM64`, `todorant-new`, and `local-build`.
