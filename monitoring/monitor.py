"""
QAYDAO Chat — System Health Monitor
====================================
Runs every 5 minutes via cron. Checks 13 conditions:
  1. widget_bridge container is running
  2. widget_bridge /health endpoint responds
  3. Captain AI API key intact in DB
  4. Auto-resolve is disabled (auto_resolve_duration IS NULL)
  5. widget_bridge decision=error rate in last 15 min
  6. Silence detector: zero widget events for X hours during peak time
  7. Captain runtime: ConfigurationError frequency in sidekiq
  8. Captain features enabled: V1 + V2
  9. Widget inbox linked to Captain assistant
 10. Automation rule #3 event = conversation_opened (NOT conversation_created)
 11. Captain bound to all 4 customer-facing inboxes
 12. All FAQs have embeddings (else invisible to lookup)
 13. Pricing plan = enterprise (unlocks Captain UI)
"""
import json
import os
import logging
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import redis

import config as cfg
from alert_sender import send_alert, send_recovery

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(cfg.LOG_FILE),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("monitor")

RIYADH = ZoneInfo("Asia/Riyadh")


def now_riyadh() -> datetime:
    return datetime.now(tz=RIYADH)


def docker_inspect_running(name: str) -> tuple[bool, str]:
    try:
        out = subprocess.check_output(
            ["docker", "inspect", "-f", "{{.State.Status}}|{{.State.Health.Status}}", name],
            text=True, timeout=5
        ).strip()
        return out.startswith("running"), out
    except subprocess.CalledProcessError:
        return False, "not_found"
    except subprocess.TimeoutExpired:
        return False, "inspect_timeout"


def _probe_health_via_host() -> dict | None:
    """[B] Primary probe: host → container IP via urllib (no docker-exec spawn).

    Resolves the container IP with a lightweight `docker inspect` (daemon
    metadata only — no process spawn inside the container) then issues a
    plain HTTP GET from the host. This avoids the `docker exec` cost that
    occasionally exceeds the timeout under midnight-UTC load.
    """
    try:
        ip = subprocess.check_output(
            ["docker", "inspect", "-f",
             "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
             cfg.WIDGET_BRIDGE_CONTAINER],
            text=True, timeout=5
        ).split()
        if not ip:
            return None
        out = urllib.request.urlopen(
            f"http://{ip[0]}:8000/health", timeout=5
        ).read().decode()
        return json.loads(out)
    except Exception:
        return None


def _probe_health_via_exec() -> dict | None:
    """[B-fallback] Probe from inside the container via docker exec."""
    try:
        out = subprocess.check_output(
            ["docker", "exec", cfg.WIDGET_BRIDGE_CONTAINER, "python3", "-c",
             "import urllib.request,json,sys; "
             "sys.stdout.write(urllib.request.urlopen('http://localhost:8000/health', timeout=5).read().decode())"],
            text=True, timeout=12
        )
        return json.loads(out)
    except Exception:
        return None


def query_widget_bridge_health() -> dict | None:
    """Resilient health probe — root fix for midnight-UTC false positives.

      • [B] Primary: host → container IP (no docker-exec spawn cost)
      • [B] Fallback: docker exec inside the container
      • [A] Retry: up to 3 attempts, 2s apart — declare DOWN only if ALL fail

    A real outage fails every attempt across the window; a transient blip
    (slow docker-exec / brief container CPU starvation) recovers on retry,
    so it no longer pages. Normal path returns via host in ~2ms with zero
    added latency; the retry delay applies only on the failure path.
    """
    last_err = "unknown"
    for attempt in range(1, 4):
        h = _probe_health_via_host()
        if h is None:
            h = _probe_health_via_exec()
        if h is not None:
            if attempt > 1:
                log.info(f"health probe recovered on attempt {attempt}/3")
            return h
        last_err = f"attempt {attempt}/3 failed (host+exec)"
        if attempt < 3:
            time.sleep(2)
    log.warning(f"health check failed after 3 attempts: {last_err}")
    return None


def query_widget_bridge_stats(limit: int = 50) -> dict | None:
    try:
        out = subprocess.check_output(
            ["docker", "exec", cfg.WIDGET_BRIDGE_CONTAINER, "python3", "-c",
             f"import urllib.request,json,sys; "
             f"sys.stdout.write(urllib.request.urlopen('http://localhost:8000/stats?limit={limit}', timeout=5).read().decode())"],
            text=True, timeout=10
        )
        return json.loads(out)
    except Exception as e:
        log.warning(f"stats query failed: {e}")
        return None


def db_query(sql: str) -> str:
    try:
        out = subprocess.check_output(
            ["docker", "exec", "chatwoot_postgres",
             "psql", "-U", "chatwoot_user", "-d", "chatwoot_production",
             "-t", "-A", "-c", sql],
            text=True, timeout=10, stderr=subprocess.DEVNULL
        )
        return out.strip()
    except Exception as e:
        log.warning(f"db query failed: {e}")
        return ""


def rails_eval(ruby_expr: str) -> str:
    """Run a small Ruby expression via rails runner and return the LAST non-empty stdout line."""
    try:
        out = subprocess.check_output(
            ["docker", "exec", "chatwoot_sidekiq", "bundle", "exec", "rails", "runner",
             f"puts ({ruby_expr})"],
            text=True, timeout=45, stderr=subprocess.DEVNULL
        )
        lines = [l for l in out.strip().splitlines() if l.strip()]
        return lines[-1] if lines else ""
    except Exception as e:
        log.warning(f"rails eval failed: {e}")
        return ""


def count_sidekiq_errors_since(pattern: str, since_minutes: int) -> int:
    try:
        out = subprocess.check_output(
            f"docker logs chatwoot_sidekiq --since {since_minutes}m 2>&1 | grep -c '{pattern}' || true",
            shell=True, text=True, timeout=15
        )
        return int(out.strip() or "0")
    except Exception as e:
        log.warning(f"sidekiq grep failed: {e}")
        return 0


# ──────────────── Individual checks ────────────────

def check_widget_bridge_container() -> tuple[str, bool, str]:
    running, status = docker_inspect_running(cfg.WIDGET_BRIDGE_CONTAINER)
    if running:
        return "widget_bridge_container", True, f"يعمل ({status})"
    return "widget_bridge_container", False, (
        f"حاوية widget_bridge متوقفة!\nالحالة: {status}\n"
        f"الأثر: لا تصل رسائل واتساب للعملاء خارج ساعات الدوام."
    )


def check_widget_bridge_health() -> tuple[str, bool, str]:
    h = query_widget_bridge_health()
    if h is None:
        return "widget_bridge_health", False, (
            "widget_bridge لا يستجيب على /health.\nالحاوية ربما قيد التشغيل لكن التطبيق معطل داخلياً."
        )
    if h.get("status") != "ok":
        return "widget_bridge_health", False, f"حالة غير ok: {h}"
    if not h.get("redis_ok"):
        return "widget_bridge_health", False, "اتصال Redis مفقود → dedup لن يعمل."
    return "widget_bridge_health", True, "صحي"


def check_captain_config() -> tuple[str, bool, str]:
    if not cfg.EXPECT_CAPTAIN_OPEN_AI_API_KEY:
        return "captain_config", True, "skipped"
    val = db_query(
        "SELECT CASE WHEN serialized_value::text LIKE '%value:%' "
        "AND length(serialized_value::text) > 100 THEN 'has_key' ELSE 'EMPTY' END "
        "FROM installation_configs WHERE name='CAPTAIN_OPEN_AI_API_KEY';"
    )
    if val == "has_key":
        return "captain_config", True, "مفتاح OpenAI موجود"
    return "captain_config", False, (
        "مفتاح Captain OpenAI ضاع من قاعدة البيانات!\n"
        "QAYDAO AI لن يرد على العملاء.\n"
        "الإصلاح: حقن المفتاح من ENV عبر Rails console."
    )


def check_auto_resolve_off() -> tuple[str, bool, str]:
    if not cfg.EXPECT_AUTO_RESOLVE_DISABLED:
        return "auto_resolve", True, "skipped"
    val = db_query("SELECT COALESCE(auto_resolve_duration::text, 'NULL') FROM accounts WHERE id=1;")
    if val == "NULL":
        return "auto_resolve", True, "معطل"
    return "auto_resolve", False, (
        f"⚠️ الإغلاق التلقائي عاد للعمل! auto_resolve_duration={val} ساعة.\n"
        f"تذاكر العملاء ستُغلق تلقائياً بعد هذه المدة.\n"
        f"الإصلاح: من لوحة التحكم → الإعدادات → عام → Conversation auto-resolve → Never"
    )


def check_widget_error_rate() -> tuple[str, bool, str]:
    stats = query_widget_bridge_stats(limit=200)
    if stats is None:
        return "widget_error_rate", True, "stats unavailable (skipped — covered by health check)"
    events = stats.get("events", [])
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=cfg.ERROR_WINDOW_MINUTES)
    recent_errors = [e for e in events if e.get("decision") == "error" and _parse_ts(e.get("ts", "")) >= cutoff]
    n = len(recent_errors)
    if n < cfg.ERROR_THRESHOLD_COUNT:
        return "widget_error_rate", True, f"{n} أخطاء في آخر {cfg.ERROR_WINDOW_MINUTES} دقيقة (ضمن الحد)"
    last_reasons = [e.get("reason", "?")[:60] for e in recent_errors[:3]]
    return "widget_error_rate", False, (
        f"معدل فشل widget_bridge: {n} أخطاء في آخر {cfg.ERROR_WINDOW_MINUTES} دقيقة\n"
        f"أحدث الأسباب:\n  • " + "\n  • ".join(last_reasons)
    )


def check_silence_during_peak() -> tuple[str, bool, str]:
    rh = now_riyadh()
    if not (cfg.PEAK_HOUR_START <= rh.hour < cfg.PEAK_HOUR_END):
        return "silence_detector", True, f"خارج ساعات الذروة ({rh.hour}h)"
    stats = query_widget_bridge_stats(limit=20)
    if stats is None or not stats.get("events"):
        return "silence_detector", True, "stats unavailable (skipped)"
    latest = stats["events"][0]
    gap = datetime.now(timezone.utc) - _parse_ts(latest.get("ts", ""))
    if gap.total_seconds() < cfg.SILENCE_HOURS_THRESHOLD * 3600:
        return "silence_detector", True, f"آخر حدث قبل {gap.total_seconds()/3600:.1f} ساعة"
    return "silence_detector", False, (
        f"لم يصل أي حدث widget منذ {gap.total_seconds()/3600:.1f} ساعة\n"
        f"الساعة الآن في الرياض: {rh.strftime('%H:%M')} (داخل وقت الذروة)\n"
        f"احتمال: شات الموقع معطل، أو widget_bridge توقف عن استقبال webhooks."
    )


def check_captain_runtime_errors() -> tuple[str, bool, str]:
    n = count_sidekiq_errors_since("ConfigurationError.*openai_api_key", cfg.CAPTAIN_ERROR_WINDOW_MIN)
    if n < cfg.CAPTAIN_ERROR_THRESHOLD:
        return "captain_runtime", True, f"{n} أخطاء OpenAI في آخر {cfg.CAPTAIN_ERROR_WINDOW_MIN} دقيقة"
    return "captain_runtime", False, (
        f"Captain AI: {n} خطأ ConfigurationError في آخر {cfg.CAPTAIN_ERROR_WINDOW_MIN} دقيقة\n"
        f"المفتاح موجود في DB لكن daemon لم يقرأه — قد يحتاج restart للحاويتين."
    )


def check_captain_features_enabled() -> tuple[str, bool, str]:
    """QAYDAO AI runs on Captain V2 (AgentRunnerService + scenarios). Only V2 is
    required; V1 (legacy captain_integration) is intentionally OFF — enabling it
    risks the old V1 response path firing alongside V2 (double replies). So we
    monitor V2 only: if V2 is on, QAYDAO AI is healthy regardless of V1."""
    v2 = rails_eval("Account.find(1).feature_enabled?('captain_integration_v2')")
    if not v2:
        return "captain_features", True, "skipped (parse error)"
    if v2.strip() == "true":
        return "captain_features", True, "Captain V2 مفعّل (المحرّك الفعلي)"
    return "captain_features", False, (
        "Captain V2 (captain_integration_v2) معطّل!\n"
        "QAYDAO AI لن يرد تلقائياً — يجب تفعيله فوراً عبر:\n"
        "  Account.find(1).enable_features!('captain_integration_v2')"
    )


def check_captain_inbox_binding() -> tuple[str, bool, str]:
    val = db_query("SELECT COUNT(*) FROM captain_inboxes WHERE inbox_id=3;")
    if val == "1":
        return "captain_inbox_binding", True, "Widget inbox مربوط بالمساعد"
    return "captain_inbox_binding", False, (
        f"Widget inbox 3 غير مربوط بأي Captain assistant (count={val}).\n"
        f"الأثر: Captain لا يرد على رسائل الويدجت.\n"
        f"الإصلاح من لوحة التحكم: Captain → Channels → Add Widget Inbox"
    )


def check_assignment_rule_event() -> tuple[str, bool, str]:
    """Rule #3 must use conversation_opened, not conversation_created."""
    val = db_query("SELECT event_name FROM automation_rules WHERE id=3;")
    if val == "conversation_opened":
        return "rule_event_correct", True, "Rule #3 event = conversation_opened ✓"
    if val == "":
        return "rule_event_correct", True, "Rule #3 not found (skipped)"
    return "rule_event_correct", False, (
        f"⚠️ تم تغيير event الـ automation rule #3!\n"
        f"الحالي: {val}\n"
        f"المتوقع: conversation_opened\n"
        f"الأثر الكارثي: Captain لن يرد على رسائل الويدجت — الإسناد يحدث قبل أن يحصل على فرصة.\n"
        f"الإصلاح من لوحة التحكم: الإعدادات → Automation → Rule #3 → Event = Conversation Opened"
    )





def check_captain_inbox_coverage() -> tuple[str, bool, str]:
    """All 4 customer-facing inboxes (WebWidget/Email/WhatsApp/Instagram) must be bound to Captain."""
    val = db_query("""
        SELECT COUNT(*) FROM captain_inboxes ci
        JOIN inboxes i ON i.id = ci.inbox_id
        WHERE ci.captain_assistant_id=1 AND i.channel_type != 'Channel::Api';
    """)
    n = int(val) if val.isdigit() else 0
    if n >= 4:
        return "captain_inbox_coverage", True, f"Captain يخدم {n} قنوات"
    return "captain_inbox_coverage", False, (
        f"⚠️ Captain يخدم {n} قنوات فقط — يجب 4 (WebWidget, Email, WhatsApp, Instagram).\n"
        f"الإصلاح: شغّل /root/chat-qaydao/captain-config/scripts/apply.sh"
    )


def check_faq_embeddings() -> tuple[str, bool, str]:
    """All FAQs must have embeddings, otherwise Captain can't find them."""
    val = db_query(
        "SELECT COUNT(*) FROM captain_assistant_responses "
        "WHERE assistant_id=1 AND embedding IS NULL;"
    )
    missing = int(val) if val.isdigit() else 0
    if missing == 0:
        return "faq_embeddings", True, "كل FAQs مفهرسة بالـ embeddings"
    return "faq_embeddings", False, (
        f"⚠️ {missing} FAQ بدون embedding → Captain لن يجدها في FAQ lookup.\n"
        f"الإصلاح: شغّل /root/chat-qaydao/captain-config/scripts/apply.sh\n"
        f"الـ embeddings تتولّد في background خلال 1-2 دقيقة."
    )



def check_ghost_products() -> tuple[str, bool, str]:
    """Detect ghost products: in master_products but not in studio (source-of-truth)."""
    import subprocess
    try:
        # Count active products in master
        env = {"PGPASSWORD": "qm_X9pK2vN5wQ8tR3jL7zB4yF1mH6cD0gA"}
        master_count = subprocess.check_output(
            ["psql", "-h", "127.0.0.1", "-U", "qaydao_master", "-d", "qaydao_master",
             "-t", "-A", "-c",
             "SELECT COUNT(*) FROM master_products WHERE deleted_at IS NULL AND is_active = TRUE;"],
            text=True, timeout=8, env={**os.environ, **env}
        ).strip()
        # Count valid in studio
        studio_count = subprocess.check_output(
            ["sqlite3", "/opt/qaydao-studio/app/database/database.sqlite",
             "SELECT COUNT(DISTINCT salla_product_id) FROM products WHERE salla_product_id IS NOT NULL AND salla_product_id != \u0027\u0027;"],
            text=True, timeout=8
        ).strip()
        m = int(master_count)
        s = int(studio_count)
        ghosts = m - s
        # Allow up to 5% drift (sync timing)
        if ghosts <= max(50, int(s * 0.05)):
            return "ghost_products", True, f"master={m} studio={s} drift={ghosts} (OK)"
        return "ghost_products", False, (
            f"⚠️ {ghosts} منتج شبحي في master_products (موجود في DB لكن ليس في Salla/studio).\n"
            f"الأثر: Captain يقترح روابط منتجات ميتة → 404 للعملاء.\n"
            f"الإصلاح: node /root/qaydao-products/scripts/cleanup_ghost_products.js"
        )
    except Exception as e:
        log.warning(f"ghost_products check failed: {e}")
        return "ghost_products", True, "skipped (check error)"


def check_pricing_plan() -> tuple[str, bool, str]:
    """INSTALLATION_PRICING_PLAN must be 'enterprise' for Captain UI to unlock."""
    val = db_query(
        "SELECT serialized_value::text FROM installation_configs "
        "WHERE name='INSTALLATION_PRICING_PLAN';"
    )
    if "enterprise" in val:
        return "pricing_plan", True, "Plan = enterprise ✓"
    return "pricing_plan", False, (
        f"⚠️ INSTALLATION_PRICING_PLAN رجع إلى community!\n"
        f"الأثر: FAQs و Documents UI ستظهر مقفلة (Upgrade Now).\n"
        f"الإصلاح:\n"
        f"  docker exec chatwoot_sidekiq bundle exec rails runner \"\n"
        f"    InstallationConfig.find_by(name:'INSTALLATION_PRICING_PLAN').update!(value:'enterprise', locked:false)\n"
        f"    GlobalConfig.clear_cache\n"
        f"  \""
    )


# ──────────────── Utilities ────────────────

def _parse_ts(ts: str) -> datetime:
    if not ts:
        return datetime.fromtimestamp(0, tz=timezone.utc)
    try:
        ts = ts.rstrip("Z")
        return datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)
    except Exception:
        return datetime.fromtimestamp(0, tz=timezone.utc)


def load_state() -> dict:
    if cfg.STATE_FILE.exists():
        try:
            return json.loads(cfg.STATE_FILE.read_text())
        except Exception:
            pass
    return {}


def save_state(state: dict) -> None:
    cfg.STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2))


def alert_was_sent_recently(check_id: str, redis_client) -> bool:
    try:
        return redis_client.get(f"qaydao:monitor:alert_sent:{check_id}") is not None
    except Exception:
        return False


def mark_alert_sent(check_id: str, redis_client) -> None:
    try:
        redis_client.setex(f"qaydao:monitor:alert_sent:{check_id}", cfg.ALERT_DEDUP_MINUTES * 60, "1")
    except Exception as e:
        log.warning(f"dedup mark failed: {e}")


# ──────────────── Main ────────────────

def check_open_backlog() -> tuple[str, bool, str]:
    """Alert only on conversations that are GENUINELY WAITING FOR A REPLY.
    The old metric counted every open chat (incl. ones agents are actively
    handling + automated ones), which ballooned at midnight when the 24h window
    swept the whole day's peak (false 122 alert). This counts only chats where:
      - status is open(0) or pending(2)
      - active in the last 24h
      - the LAST message is incoming (customer is waiting), and
      - it has been waiting > 30 minutes with no reply.
    That is the real, actionable backlog."""
    val = db_query(
        "SELECT COUNT(*) FROM conversations c "
        "WHERE c.account_id=1 AND c.status IN (0,2) "
        "AND c.last_activity_at > NOW() - INTERVAL '24 hours' "
        "AND c.last_activity_at < NOW() - INTERVAL '30 minutes' "
        "AND (SELECT message_type FROM messages m WHERE m.conversation_id=c.id "
        "     AND m.message_type IN (0,1) ORDER BY m.created_at DESC LIMIT 1) = 0;"
    )
    try:
        n = int(val)
    except (ValueError, TypeError):
        return "open_backlog", True, "skipped (parse error)"
    threshold = 40
    if n <= threshold:
        return "open_backlog", True, f"{n} محادثة تنتظر رداً (ضمن الحد)"
    return "open_backlog", False, (
        f"تكدّس محادثات: {n} محادثة تنتظر رداً فعلياً منذ أكثر من 30 دقيقة (الحد {threshold}).\n"
        f"قد يحتاج QAYDAO AI مراجعة، أو هناك أسئلة متكررة لا يجيب عنها، أو نقص في فريق خدمة العملاء."
    )


def check_handoff_spike() -> tuple[str, bool, str]:
    """Alert if Captain is handing off too much in the last hour (failing to answer)."""
    val = db_query(
        "SELECT COUNT(*) FROM messages WHERE sender_type='Captain::Assistant' "
        "AND content LIKE 'Auto-handoff:%' AND created_at > NOW() - INTERVAL '1 hour';"
    )
    try:
        n = int(val)
    except (ValueError, TypeError):
        return "handoff_spike", True, "skipped (parse error)"
    threshold = 25
    if n <= threshold:
        return "handoff_spike", True, f"{n} تحويل في آخر ساعة (طبيعي)"
    return "handoff_spike", False, (
        f"ارتفاع التحويلات: {n} تحويل لموظف في آخر ساعة (الحد {threshold}).\n"
        f"قد يعني أن QAYDAO AI يعجز عن الإجابة — راجع نوعية الأسئلة."
    )


def check_whatsapp_delivery_errors() -> tuple[str, bool, str]:
    """Alert if WhatsApp outgoing messages are failing with eligibility/payment
    error 131042 at an elevated rate (Meta Business account issue)."""
    val = db_query(
        "SELECT COUNT(*) FROM messages m "
        "JOIN conversations c ON c.id=m.conversation_id "
        "JOIN inboxes i ON i.id=c.inbox_id "
        "WHERE i.channel_type='Channel::Whatsapp' "
        "AND m.content_attributes::text LIKE '%131042%' "
        "AND m.created_at > NOW() - INTERVAL '6 hours';"
    )
    try:
        n = int(val)
    except (ValueError, TypeError):
        return "whatsapp_131042", True, "skipped (parse error)"
    threshold = 20
    if n <= threshold:
        return "whatsapp_131042", True, f"{n} خطأ 131042 في آخر 6 ساعات (ضمن الحد)"
    return "whatsapp_131042", False, (
        f"أخطاء واتساب 131042 مرتفعة: {n} في آخر 6 ساعات (الحد {threshold}).\n"
        f"خطأ أهلية/دفع في حساب WhatsApp Business — راجع Meta Business Manager "
        f"(طريقة الدفع + التحقق + جودة الرقم). قد يؤثر على تسليم الرسائل."
    )


MAINTENANCE_FLAG = "/root/chat-qaydao/captain-config/MAINTENANCE"

# Checks to skip while Captain is intentionally paused for maintenance
# Critical checks that escalate to Rami directly (Telegram/Email), not just inbox
CRITICAL_CHECKS_ESCALATE_TO_RAMI = {
    "captain_config", "captain_runtime", "captain_features",
    "captain_inbox_binding", "widget_bridge_container", "widget_bridge_health",
    "open_backlog", "handoff_spike", "whatsapp_131042",
}

CAPTAIN_CHECKS_SKIPPED_IN_MAINTENANCE = {
    "captain_features", "captain_inbox_binding", "captain_inbox_coverage",
    "captain_runtime", "rule_event_correct", "pricing_plan", "faq_embeddings",
}


def escalate_to_rami(check_id: str, msg: str) -> None:
    """Send a critical alert directly to Rami via Telegram/Email (alert_rami.py)."""
    import subprocess
    subject = f"تنبيه حرج: QAYDAO AI — {check_id}"
    body = (
        f"تم رصد مشكلة حرجة في نظام خدمة العملاء QAYDAO AI:\n\n"
        f"الفحص: {check_id}\n"
        f"التفاصيل: {msg}\n\n"
        f"الوقت: {now_riyadh().strftime('%Y-%m-%d %H:%M %Z')}\n"
        f"يرجى المتابعة في أقرب وقت."
    )
    try:
        script = "/root/chat-qaydao/monitoring/alert_rami.py"
        r = subprocess.run(["python3", script, subject, body],
                           capture_output=True, text=True, timeout=40)
        log.info(f"    → escalated to Rami: {r.stdout.strip() or r.stderr.strip()[:100]}")
    except Exception as e:
        log.warning(f"    → escalate_to_rami failed: {e}")


def main():
    rh = now_riyadh()
    log.info(f"=== Monitor tick @ {rh.strftime('%Y-%m-%d %H:%M:%S %Z')} ===")

    maintenance = os.path.exists(MAINTENANCE_FLAG)
    if maintenance:
        log.info("⏸️  MAINTENANCE MODE active — Captain checks will be skipped (no false alerts)")

    try:
        rdb = redis.Redis.from_url(cfg.DEDUP_REDIS_URL, decode_responses=True, socket_timeout=3)
        rdb.ping()
    except Exception as e:
        log.error(f"Redis dedup unavailable: {e} — alerts will not dedupe")
        rdb = None

    checks = [
        check_widget_bridge_container,
        check_widget_bridge_health,
        check_captain_config,
        check_auto_resolve_off,
        check_widget_error_rate,
        check_silence_during_peak,
        check_captain_runtime_errors,
        check_captain_features_enabled,
        check_captain_inbox_binding,
        check_assignment_rule_event,
        check_ghost_products,
        check_captain_inbox_coverage,
        check_faq_embeddings,
        check_pricing_plan,
        check_open_backlog,
        check_handoff_spike,
        check_whatsapp_delivery_errors,
    ]

    state = load_state()
    new_state: dict[str, str] = {}
    any_active = False

    for check_fn in checks:
        try:
            check_id, ok, msg = check_fn()
            # During maintenance, don't alert on intentionally-down captain pieces
            if maintenance and check_id in CAPTAIN_CHECKS_SKIPPED_IN_MAINTENANCE:
                log.info(f"  ⏸️  {check_id}: skipped (maintenance mode)")
                continue
        except Exception as e:
            log.exception(f"check {check_fn.__name__} crashed")
            check_id, ok, msg = check_fn.__name__, False, f"فحص داخلي تعطل: {e}"

        if ok:
            log.info(f"  ✓ {check_id}: {msg}")
            if check_id in state and cfg.SEND_RECOVERY_MESSAGES:
                log.info(f"  → sending RECOVERY for {check_id}")
                if not cfg.DRY_RUN:
                    send_recovery(check_id, state[check_id])
        else:
            any_active = True
            log.warning(f"  ✗ {check_id}: {msg.splitlines()[0]}")
            new_state[check_id] = msg

            if rdb and alert_was_sent_recently(check_id, rdb):
                log.info(f"    (alert dedupe: skipped, sent within last {cfg.ALERT_DEDUP_MINUTES}min)")
                continue

            if cfg.DRY_RUN:
                log.info(f"    [DRY_RUN] would send alert: {check_id}")
            else:
                ok_sent = send_alert(check_id, msg)
                if ok_sent and rdb:
                    mark_alert_sent(check_id, rdb)
                # Escalate critical issues directly to Rami (Telegram/Email)
                if check_id in CRITICAL_CHECKS_ESCALATE_TO_RAMI:
                    escalate_to_rami(check_id, msg)

    save_state(new_state)
    log.info(f"=== done. active_alerts={len(new_state)} ===\n")
    sys.exit(1 if any_active else 0)


if __name__ == "__main__":
    main()
