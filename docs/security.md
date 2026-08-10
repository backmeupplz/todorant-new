# Security model

Todorant handles private task data, account credentials, session tokens, and a
read-only path to the legacy database. Security changes should preserve the
local-first experience while treating the browser, network, and every client
operation as untrusted.

The dated production review and verification evidence is recorded in
[`security-audit-2026-08-10.md`](security-audit-2026-08-10.md).

## Implemented controls

- Passwords use Argon2id with 64 MiB memory, three iterations, and independent
  salts. Login failures are intentionally indistinguishable.
- Session identifiers contain 256 bits of randomness, are stored only as keyed
  HMAC-SHA-256 digests, and use `HttpOnly`, `Secure`, `SameSite=Strict`,
  `__Host-` cookies in production. Mutations additionally require a random CSRF
  token and the canonical browser origin.
- HTTP bodies and WebSocket frames are bounded. Global and high-risk endpoint
  rate limits cover authentication, imports, exports, delegation lookup,
  report sharing, commands, and realtime connection attempts.
- WebSockets require an authenticated session and exact production origin,
  allow at most five connections per account per API replica, reject invalid
  cursors, and terminate dead peers with ping/pong heartbeats.
- API input is allowlisted and size-limited. Unexpected backend/database errors
  are logged server-side and never returned to clients.
- The frontend uses no HTML injection API or persistent token storage. Caddy
  sends a deny-by-default Content Security Policy, HSTS, clickjacking,
  MIME-sniffing, referrer, permissions, and cross-origin isolation headers.
- PostgreSQL is private-network only. Migrations, application queries, and
  pg-boss use separate roles. The runtime role has CRUD access to application
  tables but no role, database, or schema creation rights; the job role owns
  only the `pgboss` schema.
- The production API and frontend images are digest-pinned, contain only their
  required runtime payload, and run as unprivileged users.
- The legacy Mongo connection is accepted only with an explicitly read-only
  URI and verified read privileges. Imported secret/token fields are stripped.
- Production dependencies are version-locked and container bases are digest
  pinned. Checkout credentials are not persisted and builds run on a
  repository-scoped self-hosted runner. GitHub Actions currently use major tags
  and must be commit-pinned when a credential with `workflow` scope is available.

## Deployment checklist

1. Use PostgreSQL 18.4 or a later supported security patch and keep port 5432
   unexposed.
2. Generate independent random values of at least 32 bytes for the session
   pepper and all three database credentials. Never reuse the legacy Mongo
   credential.
3. Set `WEB_ORIGIN` to the exact HTTPS origin without a trailing slash.
4. Use Cloudflare Full (strict), require TLS 1.2 or newer, and proxy only the web
   service. The API and database must not have public routes.
5. Keep PgWeb/DbGate disabled outside an explicit maintenance window.
6. Retain at least 14 daily database backups. Prefer encrypted off-host object
   storage; test restoration after setup and after schema changes.
7. Run `pnpm validate`, `pnpm audit --prod`, the container integration suite,
   and a secret scan before merging a release.

## Residual risks

- IndexedDB contains each account's locally available unencrypted tasks. A
  compromised browser profile or successful same-origin script compromise can
  read that data. Use task encryption for sensitive text and protect the device.
- Client-side task encryption protects task text, not all metadata (dates,
  ownership, tags, and sync history). Losing the local key is irreversible.
- A local backup on the application host protects against database corruption
  but not total host loss. It is not a substitute for encrypted off-host copies.
- Rate limits and WebSocket connection counts are per API replica until a
  shared limiter/pub-sub layer is introduced for horizontal scaling.
- The initial email/password release does not verify mailbox ownership. An
  email address alone is therefore never accepted as legacy-import proof;
  users should confirm a delegate's identity out of band before assigning
  private tasks.
- GitHub Action references use mutable major-version tags until a repository
  credential with `workflow` scope is available to commit-pin them.
