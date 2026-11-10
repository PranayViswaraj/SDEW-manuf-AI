#!/usr/bin/env bash
# Back up the production database to ./backups/manufai-YYYYMMDD-HHMMSS.sql.gz
# Usage (from the repo root on the server host):  ./scripts/backup.sh
# Restore:  gunzip -c backups/FILE.sql.gz | docker compose -f docker-compose.prod.yml \
#             --env-file .env.prod exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
# Keep at least one copy off this machine. The audit log is part of the database.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env.prod; set +a
mkdir -p backups
file="backups/manufai-$(date +%Y%m%d-%H%M%S).sql.gz"
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "${POSTGRES_DB:-manufai}" --no-owner | gzip > "$file"
echo "Backup written: $file ($(du -h "$file" | cut -f1))"
# Delete local backups older than 30 days.
find backups -name 'manufai-*.sql.gz' -mtime +30 -delete
