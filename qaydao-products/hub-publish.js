// حبة 2b — ناشر اللوحة → QAYDAO Hub.
// ينشر المنتجات المتغيّرة فقط إلى /products/publish (الذي يوزّعها لـStudio…).
// متسامح بالكامل: لا يرمي أبداً، لا يكسر/يبطّئ الرفع. fire-and-forget من server.js.
const HUB_URL = process.env.HUB_PUBLISH_URL;
const HUB_KEY = process.env.DISTRIBUTION_API_KEY;

/** ينشر منتجاً واحداً؛ يُرجع رمز HTTP (أو يرمي عند فشل الشبكة). */
async function publishOne(product, event = null) {
  const res = await fetch(HUB_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',          // إلزامي وإلا 302 من Laravel
      'X-Internal-Key': HUB_KEY,
    },
    body: JSON.stringify(event ? { event, product } : { product }),
    signal: AbortSignal.timeout(8000),
  });
  return res.status;
}

/**
 * ينشر مصفوفة منتجات تسلسلياً، يتسامح مع كل خطأ، يُرجع ملخّصاً.
 * @param {Array<{salla_id:string,name?:string,sku?:string,price?:number,sale_price?:number,availability?:string,image_url?:string}>} changed
 */
async function publishChangedToHub(changed) {
  if (!Array.isArray(changed) || changed.length === 0) return { ok: 0, fail: 0, skipped: 0 };
  if (!HUB_URL || !HUB_KEY) {
    console.warn('[Hub] HUB_PUBLISH_URL/DISTRIBUTION_API_KEY غير مضبوط — تخطّي النشر');
    return { ok: 0, fail: 0, skipped: changed.length };
  }

  let ok = 0, fail = 0;
  for (const p of changed) {
    try {
      const st = await publishOne(p);
      if (st === 202) ok++;
      else { fail++; console.error(`[Hub] publish ${p.salla_id} → HTTP ${st}`); }
    } catch (e) {
      fail++; console.error(`[Hub] publish ${p.salla_id} فشل: ${String(e && e.message).slice(0, 80)}`);
    }
  }
  console.log(`[Hub] نشر المتغيّر: ok=${ok} fail=${fail} / ${changed.length}`);
  return { ok, fail, skipped: 0 };
}

module.exports = { publishChangedToHub, publishDeletedToHub, publishOne };

/**
 * حبة 4b — ينشر حذف منتجات (event='deleted') إلى الـHub → تعطيل downstream (Studio/Sales).
 * @param {Array<{salla_id:string|number, sku?:string}>} items
 */
async function publishDeletedToHub(items) {
  if (!Array.isArray(items) || items.length === 0) return { ok: 0, fail: 0, skipped: 0 };
  if (!HUB_URL || !HUB_KEY) {
    console.warn('[Hub] HUB_PUBLISH_URL/DISTRIBUTION_API_KEY غير مضبوط — تخطّي نشر الحذف');
    return { ok: 0, fail: 0, skipped: items.length };
  }
  let ok = 0, fail = 0;
  for (const it of items) {
    try {
      const st = await publishOne({ salla_id: it.salla_id, sku: it.sku }, 'deleted');
      if (st === 202) ok++;
      else { fail++; console.error(`[Hub] delete ${it.salla_id} → HTTP ${st}`); }
    } catch (e) {
      fail++; console.error(`[Hub] delete ${it.salla_id} فشل: ${String(e && e.message).slice(0, 80)}`);
    }
  }
  console.log(`[Hub] نشر الحذف: ok=${ok} fail=${fail} / ${items.length}`);
  return { ok, fail, skipped: 0 };
}
