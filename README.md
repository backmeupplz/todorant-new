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

## Deployment

Create three Easypanel services: PostgreSQL 18, API, and web. Use
`apps/api/nixpacks.toml` for the API and `apps/web/nixpacks.toml` for the static
web service. Set the API environment from `.env.example`, use a unique session
pepper, and give `LEGACY_MONGO_URL` a database user restricted to `find` and
`listCollections`. The API also rejects legacy URLs that are not explicitly
marked read-only.

Route `new.todorant.com` to the web service, proxy `/api/*` and `/ws` to the API,
and preserve WebSocket upgrade headers. Cloudflare must use Full (strict) TLS.
Runtime credentials and the production legacy connection are deployment-owner
configuration and are never committed.

GitHub Actions runs only on the repository-scoped runner labels
`self-hosted`, `macOS`, `ARM64`, `todorant-new`, and `local-build`.
