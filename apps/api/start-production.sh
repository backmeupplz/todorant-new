#!/bin/sh
set -eu

pnpm --filter @todorant/api db:migrate
node apps/api/dist/security-bootstrap.js

unset MIGRATION_DATABASE_URL DATABASE_RUNTIME_PASSWORD DATABASE_BOSS_PASSWORD
exec node apps/api/dist/server.js
