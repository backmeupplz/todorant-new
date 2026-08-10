# Todorant repository rules

- Use a pnpm TypeScript monorepo.
- Web: Preact, Vite, Tailwind CSS v4, Preact Signals, IndexedDB via `idb`, and native WebSocket/fetch APIs.
- API: Fastify, `@fastify/websocket`, PostgreSQL 18, Drizzle, and pg-boss.
- Keep the initial frontend JavaScript bundle under 45 KB gzip; avoid React compatibility mode and large UI/runtime libraries.
- Optimize for compact, modern, accessible, functional UI.
- Preserve Todorant core behavior, but do not implement hero points.
- Email/password signup and login are the only authentication methods in the first release.
- Use explicit task revisions and idempotent operations for synchronization. Preserve conflicting values in immutable history.
- Never write to the legacy Todorant database. Migration access must use read-only credentials and idempotent imports.
- Work on feature branches and open pull requests. Do not push implementation directly to `main`.
- GitHub Actions must use the dedicated self-hosted runner labels and must not use GitHub-hosted build machines.
