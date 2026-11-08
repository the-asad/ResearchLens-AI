#!/usr/bin/env bash
# Runs the RLS isolation test against the database in DATABASE_URL (rolled back; no data kept).
# Requires psql. Example: DATABASE_URL='postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres' npm run test:rls
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/rls_isolation.sql"
