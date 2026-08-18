// QAYDAO Product ↔ Warehouse Link router
// Maps Salla products (salla_id) to physical warehouse codes (qd_code/cn_code).
const express = require('express');
const db = require('./db-pg');

const SERVICE_TOKEN = process.env.LINKS_SERVICE_TOKEN || '';

// Accept either a logged-in employee session OR a server-to-server service token (cn proxy).
function requireAuthOrService(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  const tok = req.headers['x-service-token'];
  if (SERVICE_TOKEN && tok && tok === SERVICE_TOKEN) return next();
  return res.status(401).json({ error: 'غير مصرح' });
}

function register(app) {
  const r = express.Router();

  // Reverse lookup: warehouse code -> linked product (used by check_warehouse_stock + UI)
  r.get('/lookup', requireAuthOrService, async (req, res) => {
    try {
      const code = String(req.query.code || '').trim().toUpperCase();
      if (!code) return res.status(400).json({ error: 'code required' });
      const { rows } = await db.query(
        `SELECT l.salla_id, l.sku, l.warehouse_qd_code, l.source,
                p.name, p.product_url, p.image_url
           FROM product_warehouse_link l
           LEFT JOIN master_products p ON p.salla_id = l.salla_id
          WHERE l.warehouse_qd_code = $1 LIMIT 1`, [code]);
      if (!rows.length) return res.json({ linked: false });
      return res.json({ linked: true, ...rows[0] });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // Batch: warehouse codes -> images (for warehouse list page)
  r.get('/images', requireAuthOrService, async (req, res) => {
    try {
      const codes = String(req.query.codes || '')
        .split(',').map(c => c.trim().toUpperCase()).filter(Boolean).slice(0, 300);
      if (!codes.length) return res.status(400).json({ error: 'codes required' });
      const { rows } = await db.query(
        `SELECT l.warehouse_qd_code, l.salla_id, p.name, p.image_url, p.product_url,
                p.price_regular, p.price_discounted
           FROM product_warehouse_link l
           LEFT JOIN master_products p ON p.salla_id = l.salla_id
          WHERE l.warehouse_qd_code = ANY($1)`, [codes]);
      const map = {};
      for (const r2 of rows) map[r2.warehouse_qd_code] = {
        salla_id: r2.salla_id, name: r2.name,
        image_url: r2.image_url, product_url: r2.product_url,
        price_regular: r2.price_regular != null ? Number(r2.price_regular) : null,
        price_discounted: r2.price_discounted != null ? Number(r2.price_discounted) : null
      };
      return res.json({ images: map });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // All links for one product
  r.get('/', requireAuthOrService, async (req, res) => {
    try {
      const sallaId = String(req.query.salla_id || '').trim();
      if (!sallaId) return res.status(400).json({ error: 'salla_id required' });
      const { rows } = await db.query(
        `SELECT warehouse_qd_code, sku, source, linked_by, linked_at
           FROM product_warehouse_link WHERE salla_id=$1 ORDER BY linked_at`, [sallaId]);
      return res.json({ salla_id: sallaId, links: rows });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // Candidate Salla products to link (searches sku + name)
  r.get('/candidates', requireAuthOrService, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.status(400).json({ error: 'q required' });
      const { rows } = await db.query(
        `SELECT salla_id, sku, name, image_url, product_url
           FROM master_products
          WHERE deleted_at IS NULL
            AND (sku ILIKE $1 OR name ILIKE $1)
          ORDER BY (sku ILIKE $1) DESC, name
          LIMIT 20`, [`%${q}%`]);
      return res.json({ query: q, candidates: rows });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // Create / upsert a manual link
  r.post('/', requireAuthOrService, async (req, res) => {
    try {
      const { salla_id, sku, warehouse_qd_code, linked_by } = req.body || {};
      if (!salla_id || !warehouse_qd_code)
        return res.status(400).json({ error: 'salla_id and warehouse_qd_code required' });
      const code = String(warehouse_qd_code).trim().toUpperCase();
      const { rows } = await db.query(
        `INSERT INTO product_warehouse_link (salla_id, sku, warehouse_qd_code, source, linked_by)
         VALUES ($1,$2,$3,'manual',$4)
         ON CONFLICT (warehouse_qd_code)
         DO UPDATE SET salla_id=EXCLUDED.salla_id, sku=EXCLUDED.sku,
                       source='manual', linked_by=EXCLUDED.linked_by, updated_at=now()
         RETURNING *`,
        [String(salla_id).trim(), sku ? String(sku).trim() : null, code, linked_by || 'employee']);
      return res.json({ success: true, link: rows[0] });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // Delete a link
  r.delete('/:code', requireAuthOrService, async (req, res) => {
    try {
      const code = String(req.params.code).trim().toUpperCase();
      const { rowCount } = await db.query(
        `DELETE FROM product_warehouse_link WHERE warehouse_qd_code=$1`, [code]);
      return res.json({ success: true, deleted: rowCount });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  app.use('/products/api/links', r);
}

module.exports = { register };
