# Production security audit — 2026-08-10

Scope: the Preact frontend, Fastify/WebSocket API, PostgreSQL 18.4 data tier,
legacy Mongo importer, dependency/build chain, GitHub workflow, Easypanel
services, Cloudflare edge, and backup recoverability for `new.todorant.com`.

## Findings and disposition

| Severity | Finding | Disposition |
| --- | --- | --- |
| High | The API and pg-boss used the PostgreSQL administrator credential at runtime. | Fixed in this change: migrations, application CRUD, and pg-boss receive separate roles. Production refuses to start with the administrator role. |
| High | No scheduled PostgreSQL backup existed. | Fixed operationally: daily backup with 14-copy retention configured and an immediate backup restored successfully to disposable PostgreSQL 18.4. The current provider is local disk; encrypted off-host storage remains required for host-loss protection. |
| Medium | The web service omitted CSP, HSTS, framing, MIME, permissions, referrer, and cross-origin headers. | Fixed in Caddy with a deny-by-default policy; verified from the non-root production container. |
| Medium | WebSockets did not explicitly validate `Origin`, cap account connections, reject malformed cursors, or remove dead peers. | Fixed with exact production origin, five connections per account/replica, bounded cursors/frames, and ping/pong termination. |
| Medium | Only authentication routes were rate limited; imports, exports, delegation lookup, report sharing, commands, and realtime handshakes were unbounded. | Fixed with a global limiter and stricter route limits. |
| Medium | Unexpected store/database errors could be returned to clients. | Fixed with a user-safe domain error allowlist and server-side-only diagnostics. |
| Medium | The application accepted arbitrary settings keys and loosely bounded encryption/schedule metadata. | Fixed with strict field/type/range allowlists. |
| Medium | CI actions and web container bases used mutable tags. | Container images are digest-pinned. GitHub Actions remain on major-version tags because the current GitHub OAuth credential lacks the `workflow` scope required to update workflow files; commit pinning remains an explicit follow-up. |
| Medium | The dependency policy delayed new releases for only one day and did not enforce trust-downgrade/exotic-source checks. | Fixed with a seven-day policy, exact reviewed exceptions, no-downgrade verification, and blocked exotic transitive sources. |
| Low | Password hashes used the lower OWASP Argon2id baseline and old hashes were never upgraded. | Fixed with 64 MiB/three iterations and successful-login rehashing. |
| Low | Session token hashing used concatenation rather than a standard MAC; cookies lacked the production `__Host-` prefix. | Fixed with HMAC-SHA-256 and `__Host-`, `Secure`, `HttpOnly`, strict same-site cookies. Existing sessions intentionally expire at rollout. |
| Low | Local Compose exposed PostgreSQL on every host interface and the web image ran Caddy as root. | Fixed with loopback binding and a dedicated unprivileged Caddy user. |

## Verified controls

- Easypanel exposes only `new.todorant.com` on the web service. The API has no
  public domain; PostgreSQL has no published port; PgWeb and DbGate are disabled.
- Cloudflare proxies the hostname, uses Full (strict), redirects HTTP to HTTPS,
  enables TLS 1.3 and browser integrity checks, disables 0-RTT, and has the free
  managed WAF/DDoS rulesets.
- The legacy Mongo credential was previously verified with nine read actions
  and zero write actions. Migration requires the legacy token and strips legacy
  credentials from retained payloads.
- Backup restore proof: the first scheduled backup restored into a disposable
  PostgreSQL 18.4 instance with 20 application/queue tables and all three
  existing user records.
- `pnpm validate`: lint, types, 38 unit/UI tests, dependency audit, production
  builds, immutable migration check, and 23,058-byte gzip initial JS budget pass.
- Disposable PostgreSQL/Mongo suite: migrations, REST/WebSocket sync,
  read-only legacy import, pg-boss startup, runtime CRUD, denied runtime DDL and
  role creation, and denied pg-boss access to application tables pass.
- Semgrep 1.172.0: 693 configured rules, 66 files, zero findings.
- Trivy 0.73.0: zero high/critical dependency, secret, or Dockerfile findings.
- Gitleaks 8.30.1: repository history and full working directory, zero leaks.
- `pnpm audit --prod`: zero known vulnerabilities at all severities.

## Open owner-level hardening

1. Cloudflare's zone minimum TLS is still 1.0. Set it to **TLS 1.2** or newer.
   The stored API token can read the setting but received HTTP 403 when editing
   it, so this requires a token with Zone Settings Edit or a dashboard change.
2. DNSSEC is disabled for `todorant.com`. Enable it in Cloudflare and publish
   the generated DS record at the registrar.
3. Cloudflare R2 is not enabled on the account, so Easypanel currently has only
   a root-protected local backup provider. Enable R2 (or another encrypted S3
   provider), move the daily backup off-host, and run the same restore proof.
4. Mailbox ownership is not verified in the initial email/password release.
   Email is never sufficient proof for legacy import; verify delegate identity
   out of band until an email verification flow is added.
5. Pin every GitHub Action to a reviewed commit SHA once a repository credential
   with `workflow` scope is available. The workflow is already least-privilege,
   disables persisted checkout credentials, and runs only on the dedicated
   self-hosted runner, but major-version action tags remain mutable upstream.
