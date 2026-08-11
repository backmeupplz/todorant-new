#!/bin/sh
set -eu

engine=${CONTAINER_ENGINE:-podman}
container="todorant-postgres-integration-$$"
mongo_container="todorant-mongo-integration-$$"
image="docker.io/library/postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15"
mongo_image="docker.io/library/mongo:8.0.14-noble@sha256:877fa303326645cd0e50a3833fce2f3c03d6eb4aac82c97a02e98879f51126d3"

cleanup() {
  "$engine" rm -f "$container" >/dev/null 2>&1 || true
  "$engine" rm -f "$mongo_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

"$engine" run --name "$container" --rm -d \
  -e POSTGRES_DB=todorant_test \
  -e POSTGRES_USER=todorant \
  -e POSTGRES_PASSWORD=todorant \
  -p "127.0.0.1::5432" \
  "$image" >/dev/null

"$engine" run --name "$mongo_container" --rm -d \
  -e MONGO_INITDB_ROOT_USERNAME=root \
  -e MONGO_INITDB_ROOT_PASSWORD=fixture-root-password \
  -p "127.0.0.1::27017" \
  "$mongo_image" >/dev/null

published_port() {
  "$engine" port "$1" "$2/tcp" | sed -n 's/.*://p' | tail -n 1
}

pg_port=$(published_port "$container" 5432)
mongo_port=$(published_port "$mongo_container" 27017)
if [ -z "$pg_port" ] || [ -z "$mongo_port" ]; then
  echo "Failed to resolve dynamically published integration ports" >&2
  exit 1
fi

attempt=0
until "$engine" exec "$container" pg_isready -U todorant -d todorant_test >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    "$engine" logs "$container"
    exit 1
  fi
  sleep 1
done

attempt=0
until "$engine" exec "$mongo_container" mongosh --quiet \
  -u root -p fixture-root-password --authenticationDatabase admin \
  --eval 'db.adminCommand({ ping: 1 }).ok' >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    "$engine" logs "$mongo_container"
    exit 1
  fi
  sleep 1
done

DATABASE_URL="postgresql://todorant:todorant@127.0.0.1:$pg_port/todorant_test"
export DATABASE_URL
TEST_DATABASE_URL=$DATABASE_URL
export TEST_DATABASE_URL

pnpm --filter @todorant/api build
MIGRATION_DATABASE_URL="$DATABASE_URL" node apps/api/dist/migrate.js
pnpm --filter @todorant/api test:integration
pnpm --filter @todorant/api exec node --input-type=module -e \
  'import { PgBoss } from "pg-boss"; const boss = new PgBoss(process.env.DATABASE_URL); await boss.start(); await boss.stop({ graceful: true });'

MIGRATION_DATABASE_URL=$DATABASE_URL
DATABASE_RUNTIME_PASSWORD=fixture-runtime-password-that-is-at-least-32-characters
DATABASE_BOSS_PASSWORD=fixture-boss-password-that-is-at-least-32-characters
export MIGRATION_DATABASE_URL DATABASE_RUNTIME_PASSWORD DATABASE_BOSS_PASSWORD
node apps/api/dist/security-bootstrap.js
TEST_RUNTIME_DATABASE_URL="postgresql://todorant_runtime:$DATABASE_RUNTIME_PASSWORD@127.0.0.1:$pg_port/todorant_test"
TEST_BOSS_DATABASE_URL="postgresql://todorant_boss:$DATABASE_BOSS_PASSWORD@127.0.0.1:$pg_port/todorant_test"
export TEST_RUNTIME_DATABASE_URL TEST_BOSS_DATABASE_URL
pnpm --filter @todorant/api test:security-integration

TEST_LEGACY_MONGO_ADMIN_URL="mongodb://root:fixture-root-password@127.0.0.1:$mongo_port/admin"
TEST_LEGACY_MONGO_URL="mongodb://legacy_reader:fixture-read-only-password@127.0.0.1:$mongo_port/todorant_legacy_fixture?authSource=todorant_legacy_fixture&readPreference=secondaryPreferred&retryWrites=false"
export TEST_LEGACY_MONGO_ADMIN_URL TEST_LEGACY_MONGO_URL
pnpm --filter @todorant/api test:legacy-integration
