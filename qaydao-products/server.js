// QAYDAO Master Catalog Server (PostgreSQL backend)
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { parse } = require('csv-parse');

const db = require('./db-pg');
const adapters = require('./adapters');
const syncEngine = require('./sync-engine');
const captain = require('./captain-manager');
const unifiedImport = require('./unified-import');
const stockEnrich = require('./stock-enrich');
const hubPublish = require('./hub-publish'); // حبة 2b — ناشر اللوحة → Hub

const PORT = process.env.PORT || 3601;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'qaydao2026';
const ADMIN_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// Allow embedding in Chatwoot
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://chat.qaydao.com");
  next();
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'qaydao-default-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30*24*60*60*1000, httpOnly: true, sameSite: 'lax' }
}));

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }
});

const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 10 });
const searchLimiter = rateLimit({ windowMs: 60*1000, max: 100 });

// ═══ Chatwoot identity (same-domain session cookie) — employees sign in once in Chatwoot ═══
const CW_BASE = (process.env.CHATWOOT_BASE_URL || 'https://chat.qaydao.com').replace(/\/$/, '');
const cwIdCache = new Map(); // tokenHash -> { t, actor }
function parseCwSession(cookieHeader) {
  try {
    const m = (cookieHeader || '').match(/cw_d_session_info=([^;]+)/);
    if (!m) return null;
    const j = JSON.parse(decodeURIComponent(m[1]));
    const at = j['access-token'] || j.access_token, client = j.client, uid = j.uid;
    if (at && client && uid) return { 'access-token': at, client, uid, 'token-type': 'Bearer' };
    return null;
  } catch { return null; }
}
async function chatwootIdentity(req) {
  const h = parseCwSession(req.headers.cookie);
  if (!h) return null;
  const keyHash = crypto.createHash('sha256').update(h['access-token'] + '|' + h.uid).digest('hex');
  const cached = cwIdCache.get(keyHash);
  if (cached && Date.now() - cached.t < 60000) return cached.actor;
  try {
    const r = await fetch(`${CW_BASE}/api/v1/profile`, { headers: h });
    if (!r.ok) { cwIdCache.set(keyHash, { t: Date.now(), actor: null }); return null; }
    const p = await r.json();
    if (!p || !p.id) return null;
    const actor = { id: String(p.id), name: (p.available_name || p.name || '').trim() || p.email, email: p.email || '' };
    cwIdCache.set(keyHash, { t: Date.now(), actor });
    if (cwIdCache.size > 200) cwIdCache.clear();
    return actor;
  } catch { return null; }
}

// ═══ Audit log (fire-and-forget — never breaks the action itself) ═══
function logAudit(req, action, summary, opts = {}) {
  const a = req.actor || { id: null, name: 'unknown', verified: false };
  db.query(
    `INSERT INTO captain_audit_log (actor_id, actor_name, verified, action, target_type, target_id, summary, details, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [a.id, a.name, !!a.verified, action, opts.target_type || null,
     opts.target_id != null ? String(opts.target_id) : null,
     summary, opts.details ? JSON.stringify(opts.details) : null,
     (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim()]
  ).catch(e => console.error('[audit]', e.message));
}

async function requireAuth(req, res, next) {
  try {
    // 1) Chatwoot session = automatic, verified, per-employee identity
    const cw = await chatwootIdentity(req);
    if (cw) { req.actor = { ...cw, verified: true }; return next(); }
  } catch {}
  // 2) legacy shared-password session (unchanged behaviour)
  if (req.session.authenticated) {
    req.actor = { id: 'admin', name: 'Admin (\u0643\u0644\u0645\u0629 \u0645\u0631\u0648\u0631)', verified: false };
    return next();
  }
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.redirect('/products/login');
  }
  return res.status(401).json({ error: '\u063A\u064A\u0631 \u0645\u0635\u0631\u062D' });
}

// ════════════════════════════════════════════════════════════
//  PUBLIC API: Search (used by Captain AI)
// ════════════════════════════════════════════════════════════

app.get('/products/api/search', searchLimiter, async (req, res) => {
  const t0 = Date.now();
  const q = String(req.query.q || req.query.query || '').trim();
  const category = String(req.query.category || '').trim() || null;
  const maxPrice = parseFloat(req.query.max_price) || null;
  const limit = Math.min(parseInt(req.query.limit) || 5, 20);
  const sessionHash = req.query.session ? crypto.createHash('sha256').update(req.query.session).digest('hex') : null;

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Query too short' });
  }

  try {
    // PostgreSQL trigram search - much better than SQLite FTS for Arabic
    // DISTINCT ON (normalized name) collapses duplicate catalog entries
    // (same product uploaded multiple times in Salla with different IDs).
    // #2 exact lookup when a product URL / salla_id is present in the query
    const idMatch = q.match(/p(\d{5,})/i) || q.match(/^\s*(\d{8,})\s*$/);
    const exactId = idMatch ? idMatch[1] : null;
    let rows = [];
    if (exactId) {
      rows = await db.all(`
        SELECT id, salla_id, sku, name, description, short_desc, category_path, category_main,
               product_type, price_regular, price_discounted, status, quantity_available,
               promo_label, weight, weight_unit, image_url, product_url, 1.0 AS name_score
        FROM master_products
        WHERE deleted_at IS NULL AND is_active = TRUE
          AND status IS DISTINCT FROM 'مخفي' AND status IS DISTINCT FROM 'غير متاح'
          AND salla_id = $1
        LIMIT 1
      `, [exactId]);
    }
    // #4 hide مخفي/غير متاح  |  #5 available-first ordering  |  fuzzy fallback
    if (rows.length === 0) {
      rows = await db.all(`
        SELECT * FROM (
          SELECT DISTINCT ON (LOWER(TRIM(name)))
                 id, salla_id, sku, name, description, short_desc, category_path, category_main,
               product_type, price_regular, price_discounted, status, quantity_available,
               promo_label, weight, weight_unit, image_url, product_url,
                 similarity(name, $1) AS name_score
          FROM master_products
          WHERE deleted_at IS NULL
            AND is_active = TRUE
            AND status IS DISTINCT FROM 'مخفي' AND status IS DISTINCT FROM 'غير متاح'
            AND (name % $1 OR name ILIKE $2 OR description ILIKE $2)
            AND ($3::TEXT IS NULL OR category_path ILIKE '%' || $3 || '%')
            AND ($4::NUMERIC IS NULL OR price_regular <= $4)
          ORDER BY LOWER(TRIM(name)), similarity(name, $1) DESC NULLS LAST,
                   quantity_available DESC NULLS LAST
        ) sub
        ORDER BY (CASE WHEN quantity_available > 0 OR status = 'متاح' THEN 1 ELSE 0 END) DESC,
                 name_score DESC NULLS LAST, price_regular ASC
        LIMIT $5
      `, [q, `%${q}%`, category, maxPrice, limit]);
    }

    const products = rows.map(p => {
      const label = (p.promo_label || '') + ' ' + (p.product_type || '');
      const madeToOrder = /يصنع|يُصنع|حسب الطلب|تنفيذ/.test(label);
      const price = Math.round(parseFloat(p.price_discounted || p.price_regular));
      const orig = p.price_discounted ? Math.round(parseFloat(p.price_regular)) : null;
      return {
        sku: p.sku,
        salla_id: p.salla_id,
        name: p.name,
        // #3 full description (was truncated to 200) so any spec text is usable
        description: (p.description || p.short_desc || '').slice(0, 600),
        category: p.category_main,
        price,
        original_price: orig,
        discount_pct: (orig && orig > price) ? Math.round((1 - price / orig) * 100) : null,
        status: p.status,
        type: p.promo_label,
        // #8 explicit delivery class for correct lead-time messaging
        delivery_class: madeToOrder ? 'made_to_order' : 'ready',
        delivery_estimate: madeToOrder ? '30-60 يوم (يُصنع حسب الطلب)' : '3-7 أيام (جاهز)',
        image: p.image_url,
        url: p.product_url,
        availability: (p.quantity_available || 0) > 0 || p.status === 'متاح' ? 'متوفر' : 'غير متوفر'
      };
    });

    // #stock: override delivery_class from REAL warehouse stock for LINKED products (safe fallback)
    await stockEnrich.enrichDeliveryFromStock(products);
    const dt = Date.now() - t0;

    // Log to ai_events for ML
    db.query(`
      INSERT INTO ai_events (event_type, event_source, query_text, outcome, response_time_ms, session_hash, payload)
      VALUES ('product_search', 'captain_or_api', $1, $2, $3, $4, $5)
    `, [
      q,
      products.length > 0 ? 'found' : 'not_found',
      dt,
      sessionHash,
      JSON.stringify({ category, max_price: maxPrice, result_count: products.length, top_product_id: rows[0]?.id })
    ]).catch(e => console.error('[AI Event log error]', e.message));

    res.json({ success: true, query: q, count: products.length, products, response_time_ms: dt });
  } catch (err) {
    console.error('[Search]', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════

app.get('/products/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/products');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/products/api/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'كلمة المرور مطلوبة' });
  if (!bcrypt.compareSync(password, ADMIN_HASH)) {
    return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
  }
  req.session.authenticated = true;
  res.json({ success: true });
});

app.post('/products/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ════════════════════════════════════════════════════════════
//  HUB LIVE INGEST — master_products يتحدّث فورياً من ناقل التوزيع
//  عام (بلا requireAuth)، موثّق بـ HMAC-SHA256
// ════════════════════════════════════════════════════════════
app.post('/products/api/hub/master-ingest', async (req, res) => {
  try {
    const secret = process.env.MASTER_INGEST_SECRET;
    if (!secret) return res.status(503).json({ error: 'not_configured' });
    const sig = req.get('X-QAYDAO-Signature') || '';
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.from('')).digest('hex');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return res.status(401).json({ error: 'bad_signature' });
    }
    const evt = (req.body && req.body.event) || '';
    const d = (req.body && req.body.data) || {};
    const sallaId = String(d.salla_id || d.id || '');
    if (!sallaId) return res.status(422).json({ error: 'no_salla_id' });

    if (evt === 'product.deleted') {
      await db.query("UPDATE master_products SET deleted_at=now(), is_active=false, updated_at=now() WHERE salla_id=$1", [sallaId]);
      return res.json({ ok: true, action: 'deleted', salla_id: sallaId });
    }

    const priceRegular = Number(d.price != null ? d.price : 0) || 0;
    const priceDisc = (d.sale_price !== null && d.sale_price !== undefined) ? (Number(d.sale_price) || 0) : null;
    const qty = (d.availability === 'in') ? 100 : 0;
    const status = d.is_active ? 'active' : 'inactive';
    await db.query(
      "INSERT INTO master_products (salla_id,name,sku,price_regular,price_discounted,quantity_available,status,image_url,description,category_main,product_url,is_active,deleted_at,source,last_synced_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,NULL,'salla_live',now(),now()) ON CONFLICT (salla_id) DO UPDATE SET name=EXCLUDED.name,sku=EXCLUDED.sku,price_regular=EXCLUDED.price_regular,price_discounted=EXCLUDED.price_discounted,quantity_available=EXCLUDED.quantity_available,status=EXCLUDED.status,image_url=EXCLUDED.image_url,description=EXCLUDED.description,category_main=EXCLUDED.category_main,product_url=EXCLUDED.product_url,is_active=true,deleted_at=NULL,source='salla_live',last_synced_at=now(),updated_at=now()",
      [sallaId, d.name || null, d.sku || null, priceRegular, priceDisc, qty, status, d.image_url || null, d.description || null, d.category || null, d.product_url || null]
    );
    return res.json({ ok: true, action: 'upserted', salla_id: sallaId });
  } catch (e) {
    console.error('[master-ingest]', e.message);
    return res.status(500).json({ error: 'ingest_failed' });
  }
});

// ════════════════════════════════════════════════════════════
//  EMPLOYEE UI
// ════════════════════════════════════════════════════════════

app.get('/products', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Unified status - shows master + all 3 systems
app.get('/products/api/status', requireAuth, async (req, res) => {
  try {
    // Master Catalog stats
    const masterRow = await db.one(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'متاح') AS available,
        COUNT(*) FILTER (WHERE status = 'مخفي') AS hidden,
        COUNT(*) FILTER (WHERE quantity_available > 0) AS in_stock,
        COUNT(DISTINCT category_main) AS unique_categories,
        AVG(price_regular) AS avg_price,
        MIN(price_regular) AS min_price,
        MAX(price_regular) AS max_price
      FROM master_products
      WHERE deleted_at IS NULL
    `);

    // Last upload
    const lastUpload = await db.one(`
      SELECT * FROM upload_jobs
      WHERE status = 'completed'
      ORDER BY started_at DESC LIMIT 1
    `);

    let daysSinceUpload = null, freshness = 'never';
    if (lastUpload?.completed_at) {
      const ageMs = Date.now() - new Date(lastUpload.completed_at).getTime();
      daysSinceUpload = Math.floor(ageMs / (24*60*60*1000));
      freshness = daysSinceUpload < 7 ? 'fresh' : (daysSinceUpload < 14 ? 'warning' : 'stale');
    }

    // System stats (parallel)
    const [studioStats, salesStats, captainStats] = await Promise.all([
      adapters.studio.getStats(),
      adapters.sales.getStats(),
      adapters.captain.getStats(db.pool)
    ]);

    // sync_status — آخر تحديث لكل منصّة + آخر مزامنة شاملة
    let syncStatus = {};
    try {
      const [studioLast, salesLast, masterLastRow] = await Promise.all([
        adapters.studio.lastUpdated(),
        adapters.sales.lastUpdated(),
        db.one("SELECT MAX(last_synced_at) AS last FROM master_products WHERE deleted_at IS NULL")
      ]);
      let reconcile = null;
      try {
        const meta = JSON.parse(fs.readFileSync('/root/qaydao-products/data/live_meta.json', 'utf8'));
        reconcile = { ts: meta.ts || meta.finished_at || null, count: meta.count || null, had_error: !!meta.had_error };
      } catch (_) {}
      syncStatus = {
        master: { last_update: masterLastRow && masterLastRow.last ? masterLastRow.last : null },
        studio: { last_update: studioLast },
        sales:  { last_update: salesLast },
        last_reconcile: reconcile
      };
    } catch (e) { syncStatus = { error: e.message }; }

    // AI events stats (last 7 days)
    const aiStats = await db.one(`
      SELECT
        COUNT(*) AS total_events,
        COUNT(DISTINCT session_hash) AS unique_sessions,
        AVG(response_time_ms)::INTEGER AS avg_response_ms,
        COUNT(*) FILTER (WHERE outcome = 'found') AS successful_searches,
        COUNT(*) FILTER (WHERE outcome = 'not_found') AS no_results
      FROM ai_events
      WHERE created_at > NOW() - INTERVAL '7 days'
    `);

    res.json({
      sync_status: syncStatus,
      master: {
        total_products: parseInt(masterRow.total),
        available: parseInt(masterRow.available || 0),
        hidden: parseInt(masterRow.hidden || 0),
        in_stock: parseInt(masterRow.in_stock || 0),
        unique_categories: parseInt(masterRow.unique_categories || 0),
        price_range: {
          avg: parseFloat(masterRow.avg_price || 0).toFixed(2),
          min: parseFloat(masterRow.min_price || 0),
          max: parseFloat(masterRow.max_price || 0)
        }
      },
      systems: {
        studio: studioStats,
        sales: salesStats,
        captain: captainStats
      },
      last_upload: lastUpload ? {
        id: lastUpload.id,
        filename: lastUpload.filename,
        uploaded_at: lastUpload.completed_at,
        uploaded_by: lastUpload.uploaded_by,
        products_added: lastUpload.products_added,
        products_updated: lastUpload.products_updated,
        products_removed: lastUpload.products_removed,
        duration_ms: lastUpload.duration_ms,
        source: lastUpload.source
      } : null,
      days_since_upload: daysSinceUpload,
      freshness,
      ai_stats: {
        total_events: parseInt(aiStats?.total_events || 0),
        unique_sessions: parseInt(aiStats?.unique_sessions || 0),
        avg_response_ms: parseInt(aiStats?.avg_response_ms || 0),
        successful_searches: parseInt(aiStats?.successful_searches || 0),
        no_results: parseInt(aiStats?.no_results || 0)
      }
    });
  } catch (err) {
    console.error('[Status]', err);
    res.status(500).json({ error: err.message });
  }
});

// Top categories
app.get('/products/api/categories', requireAuth, async (req, res) => {
  try {
    const categories = await db.all(`
      SELECT category_main, COUNT(*) AS count
      FROM master_products
      WHERE deleted_at IS NULL AND category_main IS NOT NULL AND category_main != ''
      GROUP BY category_main
      ORDER BY count DESC LIMIT 20
    `);
    res.json({ categories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload history
app.get('/products/api/uploads', requireAuth, async (req, res) => {
  try {
    const uploads = await db.all(`
      SELECT * FROM upload_jobs ORDER BY started_at DESC LIMIT 20
    `);
    res.json({
      uploads: uploads.map(u => ({
        id: u.id,
        filename: u.filename,
        file_size_mb: u.file_size ? (u.file_size / (1024*1024)).toFixed(2) : 'N/A',
        started_at: u.started_at,
        completed_at: u.completed_at,
        duration_ms: u.duration_ms,
        status: u.status,
        products_added: u.products_added,
        products_updated: u.products_updated,
        products_removed: u.products_removed,
        uploaded_by: u.uploaded_by,
        source: u.source,
        error_message: u.error_message
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload CSV
// ─── UNIFIED IMPORT (multi-platform fan-out) ──────────────────────────
// Accepts CSV or XML. Pushes to master_products + sales + studio.
// Skips deletes (never removes). Protects per-platform fields.
app.post('/products/api/upload-unified', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لم يتم تحميل أي ملف' });
  try {
    const fs = require('fs');
    const buffer = fs.readFileSync(req.file.path);
    const result = await unifiedImport.runUnifiedImport({
      buffer,
      filename: req.file.originalname,
      uploadedBy: req.session?.user || 'employee'
    });
    // Cleanup temp file
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    res.json({ success: true, result });
  } catch (err) {
    console.error('[unified-upload]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/products/api/upload', requireAuth, upload.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لم يتم تحميل أي ملف' });

  const startTime = Date.now();
  let jobId = null;

  try {
    // Backup file
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(__dirname, 'backups', `${ts}_${req.file.originalname}`);
    fs.copyFileSync(req.file.path, backupPath);

    // Compute file hash
    const fileBuffer = fs.readFileSync(req.file.path);
    const fileSha = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Count before
    const { rows: [before] } = await db.query('SELECT COUNT(*) AS n FROM master_products WHERE deleted_at IS NULL');

    // Create upload job
    const { rows: [job] } = await db.query(`
      INSERT INTO upload_jobs (filename, file_size, file_sha256, products_before, status, uploaded_by, source)
      VALUES ($1, $2, $3, $4, 'processing', $5, 'manual_csv')
      RETURNING id
    `, [req.file.originalname, req.file.size, fileSha, before.n, 'employee']);
    jobId = job.id;

    // Parse CSV
    const content = fileBuffer.toString('utf-8').replace(/^\ufeff/, '');
    const records = await new Promise((resolve, reject) => {
      parse(content, {
        columns: true,          // line 1 IS the header (Salla export). Do NOT skip it.
        skip_empty_lines: true,
        relax_quotes: true,
        relax_column_count: true
        // NOTE: removed `from_line: 2` — with columns:true it double-skipped the real
        // header and used the first product row as column names, making every row's
        // No./أسم المنتج undefined → all rows skipped → catalog mass-deleted.
      }, (err, data) => err ? reject(err) : resolve(data));
    });

    // Track existing salla IDs
    const existing = await db.all(`SELECT salla_id FROM master_products WHERE deleted_at IS NULL`);
    const existingSet = new Set(existing.map(r => r.salla_id));
    const seenSet = new Set();

    let added = 0, updated = 0, skipped = 0;
    const changed = []; // حبة 2b — المنتجات التي تغيّرت فعلاً (rowCount>0) لنشرها للـHub
    const cap = v => {
      const n = parseFloat(v);
      if (isNaN(n) || n === null) return null;
      if (n > 999999999.99) return 999999999.99;
      if (n < 0) return 0;
      return n;
    };
    const safeStr = v => v ? String(v).trim() : null;

    // Process in batches via async iteration
    for (const row of records) {
      const sallaId = safeStr(row['No.']);
      const name = safeStr(row['أسم المنتج']);
      if (!sallaId || !name) { skipped++; continue; }

      seenSet.add(sallaId);

      const category = safeStr(row['تصنيف المنتج']);
      const variants = [];
      for (let i = 1; i <= 10; i++) {
        const vn = row[`[${i}] الاسم`], vv = row[`[${i}] القيمة`];
        if (vn && vv) variants.push({ name: vn.trim(), value: vv.trim() });
      }

      const isUpdate = existingSet.has(sallaId);
      const hash = crypto.createHash('sha256').update(
        [sallaId, name, row['سعر المنتج'], row['السعر المخفض'], row['حالة المنتج']].join('|')
      ).digest('hex');

      try {
        const _upsertRes = await db.query(`
          INSERT INTO master_products (
            salla_id, sku, name, description, category_path, category_main,
            product_type, promo_label, price_regular, price_discounted,
            quantity_available, status, weight,
            image_url, variants_json, product_url, source, data_hash, source_updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'salla',$17,NOW())
          ON CONFLICT (salla_id) DO UPDATE SET
            sku = EXCLUDED.sku, name = EXCLUDED.name, description = EXCLUDED.description,
            category_path = EXCLUDED.category_path, category_main = EXCLUDED.category_main,
            product_type = EXCLUDED.product_type, promo_label = EXCLUDED.promo_label,
            price_regular = EXCLUDED.price_regular, price_discounted = EXCLUDED.price_discounted,
            quantity_available = EXCLUDED.quantity_available, status = EXCLUDED.status,
            weight = EXCLUDED.weight, image_url = EXCLUDED.image_url,
            variants_json = EXCLUDED.variants_json, product_url = EXCLUDED.product_url,
            data_hash = EXCLUDED.data_hash, source_updated_at = NOW(),
            deleted_at = NULL
          WHERE master_products.data_hash IS DISTINCT FROM EXCLUDED.data_hash
        `, [
          sallaId, safeStr(row['رمز المنتج sku']), name,
          (safeStr(row['الوصف']) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000),
          category, category ? category.split(',')[0].split('>')[0].trim() : null,
          safeStr(row['نوع المنتج']), safeStr(row['العنوان الترويجي']),
          cap(row['سعر المنتج']) || 0, cap(row['السعر المخفض']),
          parseInt(row['الكمية المتوفرة']) || null, safeStr(row['حالة المنتج']),
          cap(row['الوزن']),
          safeStr(row['صورة المنتج'])?.split(',')[0],
          JSON.stringify(variants),
          `https://qaydao.com/-/p${sallaId}`,
          hash
        ]);

        // حبة 2b — انشر فقط ما تغيّر فعلاً (INSERT أو UPDATE اجتاز شرط data_hash)
        if (_upsertRes && _upsertRes.rowCount > 0) {
          changed.push({
            salla_id: sallaId,
            name,
            sku: safeStr(row['رمز المنتج sku']),
            price: cap(row['سعر المنتج']) || 0,
            sale_price: cap(row['السعر المخفض']),
            availability: safeStr(row['حالة المنتج']),
            image_url: safeStr(row['صورة المنتج'])?.split(',')[0],
            description: (safeStr(row['الوصف']) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000) || null,
            category,
            variants,
            product_url: `https://qaydao.com/-/p${sallaId}`,
          });
        }

        if (isUpdate) updated++; else added++;
      } catch (err) {
        skipped++;
        console.error(`[Upload] Row error for ${sallaId}:`, err.message.substring(0, 100));
      }
    }

    // حبة 2b — نشر المنتجات المتغيّرة إلى الـHub (fire-and-forget — لا يحجب/يكسر الرفع)
    if (changed.length) {
      hubPublish.publishChangedToHub(changed)
        .catch(e => console.error('[Hub] batch error:', e && e.message));
    }

    // Soft-delete missing products — WITH SAFETY GUARDS (defense in depth)
    const toRemove = [...existingSet].filter(id => !seenSet.has(id));
    let removed = 0;
    let deleteSkippedReason = null;
    const REMOVE_THRESHOLD = 0.30; // never auto-remove >30% of catalog without explicit confirm
    const confirmDelete = req.query.confirm_delete === 'true';

    if (seenSet.size === 0) {
      // Parse produced ZERO valid products → bad file/format. NEVER wipe the catalog.
      throw new Error('الملف لم يُنتج أي منتج صالح (0 صفوف مُعرّفة). تم إيقاف العملية لحماية الكتالوج — تحقّق من ترويسة الملف وأعمدته (No. / أسم المنتج).');
    }

    if (toRemove.length > 0 && existingSet.size > 0 &&
        (toRemove.length / existingSet.size) > REMOVE_THRESHOLD && !confirmDelete) {
      // Suspiciously large deletion → keep adds/updates but SKIP delete and flag for confirmation.
      deleteSkippedReason = `طُلب حذف ${toRemove.length} من ${existingSet.size} منتج (> ${Math.round(REMOVE_THRESHOLD*100)}%). تم تخطّي الحذف حمايةً للكتالوج. إن كان الحذف مقصوداً أعد الرفع مع confirm_delete=true.`;
      console.warn('[Upload] delete guard tripped:', deleteSkippedReason);
    } else if (toRemove.length > 0) {
      const result = await db.query(`
        UPDATE master_products SET deleted_at = NOW()
        WHERE salla_id = ANY($1) AND deleted_at IS NULL
        RETURNING salla_id, sku
      `, [toRemove]);
      removed = result.rowCount;
      // حبة 4b — نشر الحذف إلى الـHub (fire-and-forget) → تعطيل downstream (Studio/Sales)
      if (result.rows && result.rows.length) {
        hubPublish.publishDeletedToHub(result.rows)
          .catch(e => console.error('[Hub] delete batch error:', e && e.message));
      }
    }

    const dur = Date.now() - startTime;
    const { rows: [after] } = await db.query('SELECT COUNT(*) AS n FROM master_products WHERE deleted_at IS NULL');

    // Update job
    await db.query(`
      UPDATE upload_jobs
      SET status = 'completed', products_after = $1, products_added = $2,
          products_updated = $3, products_removed = $4, completed_at = NOW(),
          duration_ms = $5
      WHERE id = $6
    `, [after.n, added, updated, removed, dur, jobId]);

    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      added, updated, removed, skipped,
      after: after.n,
      duration_ms: dur,
      job_id: jobId,
      delete_skipped_reason: deleteSkippedReason
    });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    if (jobId) {
      await db.query(
        `UPDATE upload_jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
        [err.message, jobId]
      ).catch(() => {});
    }
    console.error('[Upload]', err);
    res.status(500).json({ error: 'فشل المعالجة', message: err.message });
  }
});

// Test search (employee dashboard)
app.get('/products/api/test-search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ products: [] });

  try {
    const rows = await db.all(`
      SELECT id, salla_id, sku, name, category_main, price_regular, price_discounted,
             status, image_url, product_url,
             similarity(name, $1) AS score
      FROM master_products
      WHERE deleted_at IS NULL AND (name % $1 OR name ILIKE $2 OR description ILIKE $2)
      ORDER BY score DESC NULLS LAST
      LIMIT 10
    `, [q, `%${q}%`]);
    res.json({ count: rows.length, products: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI Events explorer
app.get('/products/api/ai-events', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const events = await db.all(`
      SELECT id, event_type, event_source, query_text, outcome,
             response_time_ms, created_at, payload
      FROM ai_events
      ORDER BY created_at DESC LIMIT $1
    `, [limit]);

    // Aggregate by hour for last 24h
    const hourly = await db.all(`
      SELECT DATE_TRUNC('hour', created_at) AS hour,
             event_type,
             COUNT(*) AS count
      FROM ai_events
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY hour, event_type
      ORDER BY hour DESC
    `);

    res.json({ recent_events: events, hourly_stats: hourly });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health
// AI Quality Scorecard history (for dashboard)
app.get('/products/api/scorecard-history', requireAuth, (req, res) => {
  try {
    const p = '/root/qaydao-products/logs/ai_scorecard_history.jsonl';
    if (!fs.existsSync(p)) return res.json({ success: true, count: 0, history: [] });
    const history = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    res.json({ success: true, count: history.length, history: history.slice(-60) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/products/api/health', async (req, res) => {
  try {
    const { rows: [r] } = await db.query('SELECT COUNT(*) AS n FROM master_products WHERE deleted_at IS NULL');
    res.json({
      status: 'ok',
      total_products: parseInt(r.n),
      version: '2.0-postgres-master'
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});
// ════════════════════════════════════════════════════════════
//  SYNC ENGINE ENDPOINTS
// ════════════════════════════════════════════════════════════

// Trigger sync - both systems
app.post("/products/api/sync/all", requireAuth, async (req, res) => {
  const dryRun = req.query.dry_run === "true";
  try {
    const result = await syncEngine.syncAll({ dryRun });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[Sync All]", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sync Studio only
app.post("/products/api/sync/studio", requireAuth, async (req, res) => {
  const dryRun = req.query.dry_run === "true";
  try {
    const result = await syncEngine.syncStudio({ dryRun });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sync Sales only
app.post("/products/api/sync/sales", requireAuth, async (req, res) => {
  const dryRun = req.query.dry_run === "true";
  try {
    const result = await syncEngine.syncSales({ dryRun });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get sync history (last 20 runs)
app.get("/products/api/sync/history", requireAuth, async (req, res) => {
  try {
    const events = await db.all(`
      SELECT id, event_source, outcome, response_time_ms, created_at, payload
      FROM ai_events WHERE event_type = 'sync_run'
      ORDER BY created_at DESC LIMIT 20
    `);
    res.json({ history: events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ════════════════════════════════════════════════════════════
//  CAPTAIN AI MANAGER ENDPOINTS
//  Allows employees to manage documents/FAQs/tools without
//  needing access to Chatwoot admin panel
// ════════════════════════════════════════════════════════════

// Dashboard for Captain manager
app.get("/products/captain", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "captain.html"));
});

// Stats
app.get("/products/api/captain/stats", requireAuth, async (req, res) => {
  try {
    const stats = await captain.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── Captain Replies Viewer ───
app.get("/products/captain/replies", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "captain-replies.html"));
});

app.get("/products/api/captain/replies", requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const channel = req.query.channel || null;
    const since_hours = parseInt(req.query.since_hours) || 24;
    const conversation_id = req.query.conversation_id || null;
    const since_id = req.query.since_id || null;
    const replies = await captain.listCaptainReplies({ limit, channel, since_hours, conversation_id, since_id });
    res.json({ replies, fetched_at: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// فتح محادثة برقمها مباشرة (قفز بلا بحث يدوي)
app.get("/products/api/captain/conversation/:id/thread", requireAuth, async (req, res) => {
  try {
    const data = await captain.getConversationThread(req.params.id);
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});


// ─── Reply Control (teach + correct from replies page) ───

// ─── Captain Maintenance (pause/resume from dashboard) ───
app.get("/products/api/captain/status", requireAuth, async (req, res) => {
  try {
    const status = await captain.getCaptainStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/products/api/captain/pause", requireAuth, async (req, res) => {
  try {
    const result = await captain.pauseCaptain();
    logAudit(req, 'captain.pause', `أوقف الكابتن مؤقتاً`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/products/api/captain/resume", requireAuth, async (req, res) => {
  try {
    const result = await captain.resumeCaptain();
    logAudit(req, 'captain.resume', `أعاد تشغيل الكابتن`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/products/api/captain/replies/:id/detail", requireAuth, async (req, res) => {
  try {
    const detail = await captain.getReplyDetail(req.params.id);
    res.json(detail);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post("/products/api/captain/replies/teach", requireAuth, async (req, res) => {
  try {
    const { question, answer, source_msg_id } = req.body || {};
    const result = await captain.teachFromReply({
      question, answer, source_msg_id,
      reviewer: req.actor?.name || 'admin'
    });
    logAudit(req, 'captain.teach', `علّم الكابتن رداً جديداً: «${String(question||'').slice(0,80)}»`,
      { target_type: 'reply', target_id: source_msg_id, details: { question, answer: String(answer||'').slice(0,500) } });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/products/api/captain/replies/related-faq", requireAuth, async (req, res) => {
  try {
    const faqs = await captain.findRelatedFAQ(req.query.text || '');
    res.json({ faqs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/products/api/captain/replies/stats", requireAuth, async (req, res) => {
  try {
    const since_hours = parseInt(req.query.since_hours) || 24;
    const [overall, by_channel] = await Promise.all([
      captain.getRepliesStats(since_hours),
      captain.getRepliesByChannel(since_hours)
    ]);
    res.json({ overall, by_channel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── Captain Learning System ───
app.get("/products/captain/learn", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "captain-learn.html"));
});

app.get("/products/api/captain/learn/suggestions", requireAuth, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const limit = parseInt(req.query.limit) || 50;
    const [suggestions, stats] = await Promise.all([
      captain.listLearningSuggestions(status, limit),
      captain.getLearningStats()
    ]);
    res.json({ suggestions, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/products/api/captain/learn/suggestions/:id/context", requireAuth, async (req, res) => {
  try {
    const sug = await captain.getLearningSuggestion(req.params.id);
    if (!sug) return res.status(404).json({ error: 'not found' });
    const messages = await captain.fetchConversationContext(sug.conversation_id);
    res.json({ suggestion: sug, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/products/api/captain/learn/suggestions/:id/approve", requireAuth, async (req, res) => {
  try {
    const { question, answer } = req.body || {};
    const result = await captain.approveLearningSuggestion(req.params.id, {
      question, answer, reviewer: req.actor?.name || 'admin'
    });
    logAudit(req, 'learn.approve', `اعتمد اقتراح تعلم #${req.params.id}: «${String(question||'').slice(0,80)}»`,
      { target_type: 'suggestion', target_id: req.params.id, details: { question, answer: String(answer||'').slice(0,500) } });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/products/api/captain/learn/suggestions/:id/reject", requireAuth, async (req, res) => {
  try {
    const { reason } = req.body || {};
    const result = await captain.rejectLearningSuggestion(req.params.id, {
      reason, reviewer: req.actor?.name || 'admin'
    });
    logAudit(req, 'learn.reject', `رفض اقتراح تعلم #${req.params.id}${reason?` — السبب: ${String(reason).slice(0,80)}`:''}`,
      { target_type: 'suggestion', target_id: req.params.id, details: { reason } });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Documents CRUD ───
app.get("/products/api/captain/documents", requireAuth, async (req, res) => {
  try {
    const docs = await captain.listDocuments();
    res.json({ documents: docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/products/api/captain/documents/:id", requireAuth, async (req, res) => {
  try {
    const doc = await captain.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    res.json({ document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/products/api/captain/documents", requireAuth, async (req, res) => {
  try {
    const doc = await captain.createDocument(req.body);
    logAudit(req, 'doc.create', `أنشأ مستند معرفة: «${String(req.body?.name||'').slice(0,80)}»`,
      { target_type: 'document', target_id: doc?.id, details: { name: req.body?.name } });
    res.json({ success: true, document: doc });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/products/api/captain/documents/:id", requireAuth, async (req, res) => {
  try {
    const doc = await captain.updateDocument(req.params.id, req.body);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    logAudit(req, 'doc.update', `عدّل مستند معرفة #${req.params.id}: «${String(req.body?.name||doc.name||'').slice(0,80)}»`,
      { target_type: 'document', target_id: req.params.id, details: { name: req.body?.name } });
    res.json({ success: true, document: doc });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/products/api/captain/documents/:id", requireAuth, async (req, res) => {
  try {
    const ok = await captain.deleteDocument(req.params.id);
    logAudit(req, 'doc.delete', `حذف مستند معرفة #${req.params.id}`,
      { target_type: 'document', target_id: req.params.id });
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── FAQs CRUD ───
app.get("/products/api/captain/faqs", requireAuth, async (req, res) => {
  try {
    const faqs = await captain.listFAQs();
    res.json({ faqs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/products/api/captain/faqs", requireAuth, async (req, res) => {
  try {
    const faq = await captain.createFAQ(req.body);
    logAudit(req, 'faq.create', `أضاف سؤالاً: «${String(req.body?.question||'').slice(0,80)}»`,
      { target_type: 'faq', target_id: faq?.id, details: { question: req.body?.question, answer: String(req.body?.answer||'').slice(0,500) } });
    res.json({ success: true, faq });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/products/api/captain/faqs/:id", requireAuth, async (req, res) => {
  try {
    const before = await captain.listFAQs().then(l => l.find(f => String(f.id) === String(req.params.id))).catch(() => null);
    const faq = await captain.updateFAQ(req.params.id, req.body);
    if (!faq) return res.status(404).json({ error: "FAQ not found" });
    logAudit(req, 'faq.update', `صحّح/عدّل السؤال #${req.params.id}: «${String(req.body?.question||faq.question||'').slice(0,80)}»`,
      { target_type: 'faq', target_id: req.params.id,
        details: { before: before ? { question: before.question, answer: String(before.answer||'').slice(0,500) } : null,
                   after: { question: req.body?.question, answer: String(req.body?.answer||'').slice(0,500) } } });
    res.json({ success: true, faq });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/products/api/captain/faqs/:id/reviewed", requireAuth, async (req, res) => {
  try {
    const flag = req.body && req.body.reviewed === true;
    const faq = await captain.setFAQReviewed(req.params.id, flag);
    if (!faq) return res.status(404).json({ error: "FAQ not found" });
    logAudit(req, 'faq.review', `${flag ? 'وسم السؤال كمُراجَع ✅' : 'ألغى مراجعة السؤال'} #${req.params.id}${faq.question ? `: «${String(faq.question).slice(0,80)}»` : ''}`,
      { target_type: 'faq', target_id: req.params.id, details: { reviewed: flag } });
    res.json({ success: true, faq });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/products/api/captain/faqs/:id", requireAuth, async (req, res) => {
  try {
    const ok = await captain.deleteFAQ(req.params.id);
    logAudit(req, 'faq.delete', `حذف السؤال #${req.params.id}`,
      { target_type: 'faq', target_id: req.params.id });
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Tools (read-only) ───
app.get("/products/api/captain/tools", requireAuth, async (req, res) => {
  try {
    const tools = await captain.listTools();
    res.json({ tools });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Assistant config (instructions/system prompt) ───
app.get("/products/api/captain/assistant", requireAuth, async (req, res) => {
  try {
    const a = await captain.getAssistant();
    res.json({ assistant: a });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/products/api/captain/assistant/instructions", requireAuth, async (req, res) => {
  try {
    const { instructions } = req.body;
    if (!instructions) return res.status(400).json({ error: "instructions required" });
    const before = await captain.getAssistant().catch(() => null);
    const cfg = await captain.updateAssistantInstructions(instructions);
    logAudit(req, 'assistant.instructions', `عدّل تعليمات/إعدادات الكابتن الأساسية ⚙️`,
      { target_type: 'assistant',
        details: { before: String(before?.instructions || '').slice(0, 4000), after: String(instructions).slice(0, 4000) } });
    res.json({ success: true, config: cfg });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Identity + Audit log ───
app.get("/products/api/whoami", requireAuth, (req, res) => {
  res.json({ ok: true, actor: req.actor });
});

app.get("/products/captain/audit", requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, "public", "captain-audit.html"));
});

app.get("/products/api/captain/audit", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 300);
    const params = []; const where = [];
    if (req.query.actor) { params.push('%' + req.query.actor + '%'); where.push("actor_name ILIKE $" + params.length); }
    if (req.query.action) { params.push(req.query.action); where.push("action = $" + params.length); }
    if (/^\d{4}-\d{2}$/.test(req.query.month || '')) { params.push(req.query.month); where.push("to_char(created_at,'YYYY-MM') = $" + params.length); }
    params.push(limit);
    const rows = await db.all(
      "SELECT id, actor_name, verified, action, target_type, target_id, summary, details, ip, created_at " +
      "FROM captain_audit_log " + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
      "ORDER BY created_at DESC LIMIT $" + params.length, params);
    const actors = await db.all(`SELECT actor_name, count(*)::int n FROM captain_audit_log GROUP BY actor_name ORDER BY n DESC LIMIT 20`);
    res.json({ ok: true, entries: rows, actors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Smart helper: AI-suggested FAQs from a document ───
// Uses simple heuristics (no LLM call yet - to be added later)
app.get("/products/api/captain/documents/:id/suggested-faqs", requireAuth, async (req, res) => {
  try {
    const doc = await captain.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });

    // Naive: split content into Q&A pairs based on "؟" markers
    const content = doc.content || '';
    const sentences = content.split(/\n\n+|\.\s+/).map(s => s.trim()).filter(s => s.length > 30);
    const questions = sentences.filter(s => s.includes('؟') || s.includes('?')).slice(0, 10);

    res.json({
      suggestions: questions.map(q => ({
        question: q.slice(0, 200),
        suggested_answer: "(يحتاج تحرير من الموظف)",
        source_document_id: doc.id
      })),
      note: "هذه اقتراحات أولية. سيتم إضافة AI suggestions في Phase 5."
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── QA Audit Dashboard (review customer service quality) ───
app.get("/products/qa-audit", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "qa-audit", "index.html"));
});


// ─── Assign-on-Reply webhook (auto-assign conversation to agent who replies) ───

// ════════════════════════════════════════════════════════════
//  PUBLIC: resolve a Salla product (by salla_id) to REAL warehouse stock
//  Used by Captain tool `lookup_salla_product` when a customer sends a product link.
// ════════════════════════════════════════════════════════════
app.get('/products/api/links/stock-by-salla', searchLimiter, async (req, res) => {
  try {
    const sallaId = String(req.query.salla_id || '').trim();
    if (!sallaId) return res.status(400).json({ error: 'salla_id required' });
    const { rows: prows } = await db.query(
      `SELECT salla_id, sku, name, product_url FROM master_products
       WHERE salla_id = $1 AND deleted_at IS NULL LIMIT 1`, [sallaId]);
    const prod = prows[0] || null;
    if (!prod) return res.json({ found: false, salla_id: sallaId });

    const { rows: lrows } = await db.query(
      `SELECT warehouse_qd_code FROM product_warehouse_link WHERE salla_id = $1`, [sallaId]);
    const codes = new Set(lrows.map(r => String(r.warehouse_qd_code).toUpperCase()));
    if (prod.sku) codes.add(String(prod.sku).trim().toUpperCase()); // auto sku==code match

    let total = 0, warehouse = [];
    if (codes.size) {
      try {
        const avail = await stockEnrich.getAvailability([...codes]);
        for (const c of codes) {
          const q = avail[c] || 0;
          if (avail[c] !== undefined) warehouse.push({ code: c, available_qty: q });
          total += q;
        }
      } catch (e) { console.error('[stock-by-salla] availability failed:', e.message); }
    }
    const ready = total > 0;
    res.json({
      found: true,
      salla_id: prod.salla_id,
      name: prod.name,
      sku: prod.sku,
      product_url: prod.product_url,
      in_stock: ready,
      available_qty: total,
      warehouse,
      delivery_class: ready ? 'ready' : 'made_to_order',
      delivery_estimate: ready ? '3-7 أيام (جاهز)' : '30-60 يوم (يُصنع حسب الطلب)'
    });
  } catch (err) {
    console.error('[stock-by-salla]', err);
    res.status(500).json({ error: err.message });
  }
});

require('./links-router').register(app);
require('./assign-on-reply').register(app);

app.listen(PORT, '127.0.0.1', async () => {
  console.log(`✅ QAYDAO Master Catalog on http://127.0.0.1:${PORT}/products`);
  try {
    const { rows: [r] } = await db.query('SELECT COUNT(*) AS n FROM master_products WHERE deleted_at IS NULL');
    console.log(`   Master Products: ${r.n}`);
    const studioStats = await adapters.studio.getStats();
    console.log(`   Studio: ${studioStats.total}`);
    const salesStats = await adapters.sales.getStats();
    console.log(`   Sales: ${salesStats.total}`);
  } catch (err) {
    console.error('Boot stats error:', err.message);
  }
});
