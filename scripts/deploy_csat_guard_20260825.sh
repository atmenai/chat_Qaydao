#!/usr/bin/env bash
# QAYDAO 2026-08-25 — ربط حارس CSAT بالحاويات الثلاث
# لا يُنفَّذ إلا بموافقة صريحة. idempotent: لا يكرر السطر إن وُجد.
set -euo pipefail
cd /root/chat-qaydao

PATCH="./patches/initializers/qaydao_csat_human_guard.rb"
LINE="      - ${PATCH}:/app/config/initializers/qaydao_csat_human_guard.rb:ro"
ANCHOR="qaydao_captain_resolution_guard.rb:/app/config/initializers/qaydao_captain_resolution_guard.rb:ro"

[ -f "$PATCH" ] || { echo "PATCH file missing"; exit 1; }

TS=$(date +%Y%m%d_%H%M%S)
cp docker-compose.yml "docker-compose.yml.bak-csatguard-${TS}"
echo "backup: docker-compose.yml.bak-csatguard-${TS}"

if grep -q 'qaydao_csat_human_guard.rb' docker-compose.yml; then
  echo "[skip] السطر موجود أصلاً"
else
  # يُدرج بعد كل ظهور للمرساة (web + sidekiq + sidekiq_captain)
  sed -i "\|${ANCHOR}|a\\${LINE}" docker-compose.yml
  echo "[ok] أُدرج $(grep -c 'qaydao_csat_human_guard.rb' docker-compose.yml) مرات"
fi

docker compose config -q && echo "[ok] docker-compose.yml صالح"
grep -n 'qaydao_csat_human_guard.rb' docker-compose.yml
