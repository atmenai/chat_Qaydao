#!/bin/bash
# QAYDAO Returns Service — daily backup (database + uploaded files)
# Keeps 30 daily backups, then prunes the oldest.
# Cron: 0 3 * * *  /root/chat-qaydao/returns-service/backup.sh >> /var/log/returns-backup.log 2>&1

set -uo pipefail

BACKUP_ROOT="/root/backups/returns"
KEEP_DAYS=30
TS="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$TS"
DB_CONTAINER="returns_db"
APP_CONTAINER="returns_service"
DB_USER="rguard"
DB_NAME="returns"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
fail() { log "ERROR: $*"; exit 1; }

log "=== Returns backup started ==="

# --- preflight: containers must be running ---
docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"  || fail "$DB_CONTAINER is not running"
docker ps --format '{{.Names}}' | grep -qx "$APP_CONTAINER" || fail "$APP_CONTAINER is not running"

mkdir -p "$DEST" || fail "cannot create $DEST"

# --- 1. database dump (full, restorable) ---
if docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists \
     > "$DEST/returns_db.sql" 2>"$DEST/.dump_err"; then
    gzip -f "$DEST/returns_db.sql"
    log "DB dump OK: $(du -h "$DEST/returns_db.sql.gz" | cut -f1)"
    rm -f "$DEST/.dump_err"
else
    log "DB dump FAILED: $(cat "$DEST/.dump_err" 2>/dev/null | tail -2)"
    fail "pg_dump failed"
fi

# --- 2. uploaded files (bank attachments + transfer receipts) ---
if docker cp "$APP_CONTAINER:/data/uploads" "$DEST/uploads" 2>/dev/null; then
    FILE_COUNT=$(find "$DEST/uploads" -type f 2>/dev/null | wc -l)
    if [ "$FILE_COUNT" -gt 0 ]; then
        tar -czf "$DEST/uploads.tar.gz" -C "$DEST" uploads && rm -rf "$DEST/uploads"
        log "Uploads OK: $FILE_COUNT file(s), $(du -h "$DEST/uploads.tar.gz" | cut -f1)"
    else
        rm -rf "$DEST/uploads"
        log "Uploads: none yet (skipped)"
    fi
else
    log "WARN: could not copy uploads (continuing — DB dump is the critical part)"
fi

# --- 3. sanity check: the dump must actually contain the table ---
# 2026-09-06: كان `zcat | grep -q` يقتل zcat بـSIGPIPE ومع pipefail يُحسب فشلاً
# كاذباً رغم سلامة النسخة. zgrep -c يقرأ الملف كاملاً فلا SIGPIPE.
HITS="$(zgrep -c "return_requests" "$DEST/returns_db.sql.gz" || true)"
if [ "${HITS:-0}" -lt 1 ]; then
    fail "dump looks invalid (return_requests not found)"
fi
ROWS=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
        -c "SELECT count(*) FROM return_requests;" 2>/dev/null || echo "?")
log "Verified: dump contains return_requests (live rows: $ROWS)"

# --- 4. prune old backups ---
if [ -d "$BACKUP_ROOT" ]; then
    PRUNED=$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +$KEEP_DAYS -print -exec rm -rf {} + 2>/dev/null | wc -l)
    [ "$PRUNED" -gt 0 ] && log "Pruned $PRUNED backup(s) older than $KEEP_DAYS days"
fi

TOTAL=$(du -sh "$BACKUP_ROOT" 2>/dev/null | cut -f1)
COUNT=$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l)
log "=== Done. $COUNT backup(s) kept, total $TOTAL — latest: $DEST ==="
