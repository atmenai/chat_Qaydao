/**
 * QAYDAO — catalog reconcile (master_products + B2B hub_products).
 * Reads data/live_catalog.json + data/live_meta.json produced by the puller.
 *
 * SAFETY GUARD (root-cause protection against a transient Salla outage
 * silently emptying the catalog): refuses to soft-delete ghosts when the
 * pull looks incomplete. Aborts (exit 2, NO writes) if any of:
 *   - meta.had_error                       (a page failed mid-pull)
 *   - count < MIN_ABSOLUTE                  (absurdly small)
 *   - expected_total > 0 && count < 98% of expected_total
 * On a healthy pull it upserts every live product (fresh price/image/status,
 * un-deletes) and soft-deletes anything not in the live set.
 */
const fs = require('fs');
const db = require('/root/qaydao-products/db-pg.js');
const Database = require('/opt/b2b/api/node_modules/better-sqlite3');

const DATA = '/root/qaydao-products/data';
const B2B_DB = '/opt/b2b/api/data/hub_products.db';
const MIN_ABSOLUTE = 1000;
const MIN_RATIO = 0.98;

const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
const log = m => console.log('[reconcile] ' + m);

(async () => {
  let live, meta;
  try {
    live = JSON.parse(fs.readFileSync(DATA + '/live_catalog.json', 'utf8'));
    meta = JSON.parse(fs.readFileSync(DATA + '/live_meta.json', 'utf8'));
  } catch (e) {
    log('ABORT: cannot read pull output — ' + e.message);
    process.exit(2);
  }

  const count = Array.isArray(live) ? live.length : 0;
  const expected = Number(meta.expected_total || 0);

  // ---- SAFETY GUARD ----
  if (meta.had_error) {
    log(`ABORT (guard): pull had_error=true — refusing to delete ghosts (count=${count})`);
    process.exit(2);
  }
  if (count < MIN_ABSOLUTE) {
    log(`ABORT (guard): count=${count} < ${MIN_ABSOLUTE} — suspicious, no writes`);
    process.exit(2);
  }
  if (expected > 0 && count < Math.floor(expected * MIN_RATIO)) {
    log(`ABORT (guard): count=${count} < 98% of expected=${expected} — partial pull, no writes`);
    process.exit(2);
  }
  log(`guard OK: count=${count} expected=${expected}`);

  const liveSet = new Set(live.map(p => String(p.salla_id)));

  // ---- MASTER (Postgres) ----
  const UP = "INSERT INTO master_products (salla_id,name,sku,price_regular,price_discounted,quantity_available,status,image_url,description,category_main,product_url,is_active,deleted_at,source,last_synced_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,NULL,'salla_reconcile',now(),now()) ON CONFLICT (salla_id) DO UPDATE SET name=EXCLUDED.name,sku=EXCLUDED.sku,price_regular=EXCLUDED.price_regular,price_discounted=EXCLUDED.price_discounted,quantity_available=EXCLUDED.quantity_available,status=EXCLUDED.status,image_url=EXCLUDED.image_url,description=EXCLUDED.description,category_main=EXCLUDED.category_main,product_url=EXCLUDED.product_url,is_active=true,deleted_at=NULL,last_synced_at=now(),updated_at=now()";
  let mUp = 0;
  for (const p of live) {
    const qty = p.quantity != null ? Number(p.quantity) : (p.availability === 'in' ? 100 : 0);
    await db.query(UP, [String(p.salla_id), p.name ?? null, p.sku ?? null, num(p.price), num(p.sale_price), qty, p.status ?? null, p.image_url ?? null, p.description ?? null, p.category ?? null, p.product_url ?? null]);
    mUp++;
  }
  const act = await db.query("SELECT salla_id FROM master_products WHERE deleted_at IS NULL");
  const ghosts = act.rows.map(r => String(r.salla_id)).filter(id => !liveSet.has(id));
  if (ghosts.length) {
    await db.query("UPDATE master_products SET deleted_at=now(),is_active=false,updated_at=now() WHERE salla_id = ANY($1)", [ghosts]);
  }
  const mActive = (await db.query("SELECT COUNT(*) c FROM master_products WHERE deleted_at IS NULL")).rows[0].c;
  log(`MASTER upserted=${mUp} ghosts_deleted=${ghosts.length} active=${mActive}`);

  // ---- B2B (SQLite) ----
  const sq = new Database(B2B_DB);
  sq.pragma('journal_mode=WAL');
  const BUP = sq.prepare("INSERT INTO hub_products (salla_id,name,sku,price,sale_price,availability,is_active,image_url,description,category,product_url,raw_json,deleted_at,updated_at) VALUES (@salla_id,@name,@sku,@price,@sale_price,@availability,1,@image_url,@description,@category,@product_url,NULL,NULL,datetime('now')) ON CONFLICT(salla_id) DO UPDATE SET name=excluded.name,sku=excluded.sku,price=excluded.price,sale_price=excluded.sale_price,availability=excluded.availability,is_active=1,image_url=excluded.image_url,description=excluded.description,category=excluded.category,product_url=excluded.product_url,deleted_at=NULL,updated_at=datetime('now')");
  const txUp = sq.transaction(items => { for (const p of items) BUP.run({ salla_id: String(p.salla_id), name: p.name ?? null, sku: p.sku ?? null, price: num(p.price), sale_price: num(p.sale_price), availability: p.availability ?? 'out', image_url: p.image_url ?? null, description: p.description ?? null, category: p.category ?? null, product_url: p.product_url ?? null }); });
  txUp(live);
  const bact = sq.prepare("SELECT salla_id FROM hub_products WHERE deleted_at IS NULL").all();
  const bdel = sq.prepare("UPDATE hub_products SET is_active=0,deleted_at=datetime('now'),updated_at=datetime('now') WHERE salla_id=?");
  let bGhost = 0;
  const txDel = sq.transaction(() => { for (const r of bact) { if (!liveSet.has(String(r.salla_id))) { bdel.run(String(r.salla_id)); bGhost++; } } });
  txDel();
  const bActive = sq.prepare("SELECT COUNT(*) c FROM hub_products WHERE deleted_at IS NULL").get().c;
  const bImg = sq.prepare("SELECT COUNT(*) c FROM hub_products WHERE deleted_at IS NULL AND image_url IS NOT NULL").get().c;
  log(`B2B upserted=${live.length} ghosts_deleted=${bGhost} active=${bActive} with_image=${bImg}`);

  log('DONE');
  process.exit(0);
})().catch(e => { console.error('[reconcile] FATAL ' + e.message); process.exit(1); });
