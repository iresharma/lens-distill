#!/usr/bin/env bash
#
# Dumps a source Postgres database (e.g. Neon) to a temporary plain-SQL file,
# then restores it into a target Postgres database via psql.
#
# Plain-SQL (rather than custom format + pg_restore) is used deliberately:
# newer pg_dump/pg_restore binaries unconditionally emit
# `SET transaction_timeout = 0;` (a PG17+ GUC) into the dump, which errors
# out against older target servers and can't be edited out of a binary
# custom-format archive. With plain SQL we can filter that line with grep
# before executing it. The `vector` extension is excluded from the dump
# entirely and assumed to be pre-installed on the target, since it's
# commonly owned by a superuser role that the target connection user may not
# have (--clean's DROP EXTENSION would otherwise fail on ownership).
#
# Usage:
#   ./scripts/migrate-db.sh <source_uri> <target_uri>
#
# Example:
#   ./scripts/migrate-db.sh \
#     "postgresql://user:pass@ep-xxxx.neon.tech/dbname?sslmode=require" \
#     "postgresql://user:pass@localhost:5432/dbname"

set -euo pipefail

SOURCE_URI="${1:-}"
TARGET_URI="${2:-}"

if [[ -z "$SOURCE_URI" || -z "$TARGET_URI" ]]; then
  echo "Usage: $0 <source_uri> <target_uri>" >&2
  exit 1
fi

for bin in pg_dump psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Error: $bin not found on PATH" >&2
    exit 1
  fi
done

DUMP_FILE="$(mktemp -t lens-distill-dump.XXXXXX)"
trap 'rm -f "$DUMP_FILE"' EXIT

echo "Dumping source database to $DUMP_FILE..."
pg_dump \
  --format=plain \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  --exclude-extension=vector \
  --dbname="$SOURCE_URI" \
  | grep -v '^SET transaction_timeout' \
  > "$DUMP_FILE"

echo "Restoring into target database..."
psql \
  --set ON_ERROR_STOP=1 \
  --dbname="$TARGET_URI" \
  --file="$DUMP_FILE"

echo "Done."
