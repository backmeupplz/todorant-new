FROM node:24-alpine@sha256:0e6f1567e269207c28295276928277a030139cbc5a0fb7d5bd2674f0401a9082 AS build

WORKDIR /app

ENV CI=true

RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @todorant/web build

FROM caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d

WORKDIR /app

ENV PORT=8080
ENV XDG_CONFIG_HOME=/config
ENV XDG_DATA_HOME=/data

RUN addgroup -S caddy && adduser -S -D -H -G caddy caddy \
  && mkdir -p /config /data /app \
  && chown -R caddy:caddy /config /data /app

COPY --chown=caddy:caddy apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --chown=caddy:caddy --from=build /app/apps/web/dist /app/apps/web/dist

USER caddy

EXPOSE 8080

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
