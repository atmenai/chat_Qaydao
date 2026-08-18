require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ host:'127.0.0.1', database:'qaydao_master', user:'qaydao_master', password:process.env.PG_PASSWORD, port:5432 });
const KEY = process.env.OPENAI_API_KEY;
const OUT = path.join(__dirname, 'exports', 'ministry_239.jsonl');
const DONE = OUT + '.done';
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, '');
try { fs.unlinkSync(DONE); } catch(e){}

function stripHtml(s){
  if(!s) return '';
  return String(s)
    .replace(/<br\s*\/?>/gi,' ')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|td)>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<')
    .replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;/gi,"'")
    .replace(/[•✔●▪►–—]/g,' ')
    .replace(/\s+/g,' ').trim();
}
function round2(n){ return Math.round((Number(n)+Number.EPSILON)*100)/100; }
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function translateBatch(items, attempt=1){
  const sys = 'You are a professional Arabic-to-English translator for a furniture and equipment e-commerce catalog (home, office, salon, cafe furniture). Translate the product name and description faithfully and naturally into clear commercial English. Keep measurements/numbers. Return ONLY valid JSON as {"items":[{"i":<number>,"name_en":"...","desc_en":"..."}]} with no markdown.';
  const user = JSON.stringify(items.map(x=>({ i:x.i, name:x.name, desc:x.desc })));
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+KEY},
      body:JSON.stringify({ model:'gpt-4o-mini', temperature:0.2, response_format:{type:'json_object'},
        messages:[{role:'system',content:sys},{role:'user',content:user}] })
    });
    const j = await r.json();
    if(!j.choices) throw new Error('no choices: '+JSON.stringify(j).slice(0,200));
    const parsed = JSON.parse(j.choices[0].message.content);
    const arr = parsed.items || parsed.translations || [];
    const map = {};
    for(const e of arr) map[e.i] = e;
    return map;
  } catch(e){
    if(attempt < 3){ await sleep(1500*attempt); return translateBatch(items, attempt+1); }
    console.error('[batch-fail]', e.message);
    return {};
  }
}

(async()=>{
  const sql = `
    WITH latest AS (
      SELECT DISTINCT ON (salla_id) salla_id, sku, name, description, price_regular, price_discounted, taxable, category_path
      FROM master_products
      WHERE source='salla' AND is_active AND deleted_at IS NULL
      ORDER BY salla_id, source_version DESC NULLS LAST, source_updated_at DESC NULLS LAST, id DESC
    )
    SELECT sku, name, description, price_regular, price_discounted, taxable
    FROM latest
    WHERE category_path LIKE '%تجهيز المشاريع%'
       OR category_path LIKE '%طقم مكتب تنفيذي%'
       OR category_path LIKE '%مكاتب مفضلة%'
    ORDER BY name;`;
  const { rows } = await pool.query(sql);
  console.log('rows fetched:', rows.length);

  const recs = rows.map((r,idx)=>{
    const sell = (r.price_discounted!=null && Number(r.price_discounted)>0) ? Number(r.price_discounted) : Number(r.price_regular||0);
    const price = r.taxable ? round2(sell*1.15) : round2(sell);
    return { i: idx, sku:(r.sku||'').trim(), name_ar:(r.name||'').trim(), desc_ar: stripHtml(r.description), price };
  });

  const BATCH = 5;
  let done = 0;
  for(let s=0; s<recs.length; s+=BATCH){
    const chunk = recs.slice(s, s+BATCH);
    const tmap = await translateBatch(chunk.map(c=>({ i:c.i, name:c.name_ar, desc:c.desc_ar.slice(0,2200) })));
    const lines = chunk.map(c=>{
      const t = tmap[c.i] || {};
      return JSON.stringify({
        sku: c.sku,
        name_ar: c.name_ar,
        name_en: (t.name_en||'').trim(),
        desc_ar: c.desc_ar,
        desc_en: (t.desc_en||'').trim(),
        price: c.price
      });
    });
    fs.appendFileSync(OUT, lines.join('\n')+'\n');
    done += chunk.length;
    console.log(`translated ${done}/${recs.length}`);
    await sleep(400);
  }
  fs.writeFileSync(DONE, String(done));
  console.log('ALL DONE', done);
  await pool.end();
})().catch(e=>{ console.error('FATAL', e); process.exit(1); });
