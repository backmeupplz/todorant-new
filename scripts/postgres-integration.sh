#!/bin/sh
set -eu

pg_bin=${PG_BIN:-}
if [ -z "$pg_bin" ]; then
  pg_bin=$(dirname "$(command -v initdb)")
fi

pg_root=$(mktemp -d /tmp/todorant-postgres.XXXXXX)
pg_data="$pg_root/data"
pg_socket="$pg_root/socket"
pg_port=55432
mkdir "$pg_socket"

cleanup() {
  "$pg_bin/pg_ctl" -D "$pg_data" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$pg_root"
}
trap cleanup EXIT INT TERM

"$pg_bin/initdb" -D "$pg_data" --auth=trust --no-locale --encoding=UTF8 >/dev/null
"$pg_bin/pg_ctl" -D "$pg_data" -o "-h 127.0.0.1 -p $pg_port -k $pg_socket" -w start >/dev/null
"$pg_bin/createdb" -h 127.0.0.1 -p "$pg_port" todorant_test

DATABASE_URL="postgresql://127.0.0.1:$pg_port/todorant_test"
export DATABASE_URL
TEST_DATABASE_URL=$DATABASE_URL
export TEST_DATABASE_URL

pnpm db:migrate
pnpm --filter @todorant/api test:integration
