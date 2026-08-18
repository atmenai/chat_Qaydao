#!/usr/bin/env bash
# QAYDAO — daily catalog reconcile orchestrator.
# Pull live Salla catalog (Hub) -> reconcile master + B2B (guarded).
# flock prevents overlap if a run is slow. All output appended to reconcile.log.
set -uo pipefail

DATA=/root/qaydao-products/data
LOG="$DATA/reconcile.log"
LOCK="$DATA/reconcile.lock"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -u +'%F %T') UTC  SKIP (already running)" >> "$LOG"
  exit 0
fi

echo "==================== $(date -u +'%F %T') UTC  START ====================" >> "$LOG"

# 1) Pull from Salla (Hub, php8.4)
php /var/www/rami.qaydao.com/scripts/pull_salla_catalog.php >> "$LOG" 2>&1
pull_rc=$?
echo "$(date -u +'%F %T') UTC  pull rc=$pull_rc" >> "$LOG"

if [ "$pull_rc" -ne 0 ]; then
  echo "$(date -u +'%F %T') UTC  ABORT: pull failed (rc=$pull_rc), skipping reconcile" >> "$LOG"
  echo "==================== $(date -u +'%F %T') UTC  END rc=$pull_rc ====================" >> "$LOG"
  exit "$pull_rc"
fi

# 2) Reconcile master + B2B (guarded)
cd /root/qaydao-products && node reconcile-catalog.cjs >> "$LOG" 2>&1
rec_rc=$?
echo "==================== $(date -u +'%F %T') UTC  END rc=$rec_rc ====================" >> "$LOG"
exit "$rec_rc"
