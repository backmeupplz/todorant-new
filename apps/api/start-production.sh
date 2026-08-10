#!/bin/sh
set -eu

node dist/migrate.js
node dist/security-bootstrap.js

unset MIGRATION_DATABASE_URL DATABASE_RUNTIME_PASSWORD DATABASE_BOSS_PASSWORD
exec node dist/server.js
