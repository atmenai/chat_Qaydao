/* QAYDAO — "المرجعات" tab inside the conversation panel (next to الرسائل / إدارة المنتجات).
 * Opens an overlay with the Customer-Service return-request form, wired to the current
 * conversation_id (read from the URL). Saves to the isolated returns-service API.
 * Same robustness pattern as other qaydao-*.js injectors. Re-check after Chatwoot upgrades.
 */
(function () {
  "use strict";
  if (window.__qd_returns_tab) return;
  window.__qd_returns_tab = true;

  var API = "/returns/api";
  var NAV_ID = "qd-returns-nav-item";
  var REASONS = ["المنتج تالف","المنتج غير مطابق للوصف","وصل منتج مختلف","العميل غيّر رأيه","تأخر التوصيل","مشكلة في المقاس أو اللون","نقص في الطلب","سبب آخر"];
  var ASSIGNEES = ["في","مروة","أميرة"];   // fallback only; the real list is fetched from Chatwoot
  // طريقة الاسترداد — القيمة المخزّنة (إنجليزي) مقابل ما يراه الموظف (عربي).
  var REFUND_OPTS = [["tabby","تابي"],["tamara","تمارا"],["madfooat","مدفوع"],["bank_account","الحساب البنكي"]];
  var REFUND_REF_METHODS = ["tabby","tamara","madfooat"];
  function refundLabel(v){for(var i=0;i<REFUND_OPTS.length;i++){if(REFUND_OPTS[i][0]===v)return REFUND_OPTS[i][1]}return ""}
  var AGENTS_CACHE = null;

  // Fetch the account's agents from Chatwoot (uses the logged-in agent's cookie).
  function fetchAgents(cb) {
    if (AGENTS_CACHE) { cb(AGENTS_CACHE); return; }
    fetch("/api/v1/profile", { credentials: "same-origin", headers: { "Accept": "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) {
        var accId = null;
        try {
          if (p && p.accounts && p.accounts.length) accId = p.accounts[0].id;
          else if (p && p.account_id) accId = p.account_id;
        } catch (e) {}
        if (!accId) throw 0;
        return fetch("/api/v1/accounts/" + accId + "/agents", {
          credentials: "same-origin", headers: { "Accept": "application/json" }
        }).then(function (r) { return r.ok ? r.json() : null; });
      })
      .then(function (list) {
        var names = [];
        if (Array.isArray(list)) {
          list.forEach(function (a) {
            var n = (a && (a.available_name || a.name || "")).trim();
            if (n && names.indexOf(n) < 0) names.push(n);
          });
        }
        AGENTS_CACHE = names.length ? names : ASSIGNEES.slice();
        cb(AGENTS_CACHE);
      })
      .catch(function () { AGENTS_CACHE = ASSIGNEES.slice(); cb(AGENTS_CACHE); });
  }

  // Fill the assignee <select> with the live agent list.
  function fillAssignees() {
    var sel = document.getElementById("q_assignee");
    if (!sel) return;
    fetchAgents(function (names) {
      var cur = sel.value;
      sel.innerHTML = '<option value="">— اختر —</option>' +
        names.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join("");
      if (cur && names.indexOf(cur) >= 0) sel.value = cur;
    });
  }

  function convId() {
    var m = location.pathname.match(/\/conversations\/(\d+)/) || location.pathname.match(/\/inbox\/[^/]*\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  // Cache the agent name once fetched, so we don't call the API repeatedly.
  var __agentNameCache = null;
  // Synchronous best-effort (used by the save() path); may be empty on Vue3.
  function agentName() {
    if (__agentNameCache) return __agentNameCache;
    // localStorage fallback (some Chatwoot builds persist auth here)
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var v = localStorage.getItem(localStorage.key(i));
        if (v && v.indexOf('"name"') >= 0 && (v.indexOf('available_name') >= 0 || v.indexOf('"email"') >= 0)) {
          var o = JSON.parse(v); var d = o && (o.data || o);
          if (d && (d.available_name || d.name)) { __agentNameCache = (d.available_name || d.name).trim(); return __agentNameCache; }
        }
      }
    } catch (e) {}
    return "";
  }
  // Reliable async fetch via Chatwoot's own profile API (uses the logged-in cookie).
  function fetchAgentName(cb) {
    if (__agentNameCache) { cb(__agentNameCache); return; }
    var quick = agentName();
    if (quick) { cb(quick); return; }
    fetch("/api/v1/profile", { credentials: "same-origin", headers: { "Accept": "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (u) {
        var nm = u ? (u.available_name || u.name || "") : "";
        if (nm) __agentNameCache = nm.trim();
        cb(__agentNameCache || "");
      })
      .catch(function () { cb(""); });
  }
  function esc(s){return (s==null?"":String(s)).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}

  /* --- IBAN: always starts with SA, digits only after it, 24 chars total --- */
  function ibanNormalize(v){
    v=(v||"").toUpperCase().replace(/\s/g,"");
    // strip any leading SA (however many the user pasted/typed), keep digits only
    var digits=v.replace(/^(SA)+/,"").replace(/\D/g,"");
    return "SA"+digits.slice(0,22);
  }
  function ibanValid(v){ return /^SA\d{22}$/.test(v||""); }
  window.qdIban=function(el){
    var pos=el.selectionStart;
    var before=el.value;
    el.value=ibanNormalize(el.value);
    // keep the caret sane and never let it sit inside "SA"
    var np=Math.max(2, pos + (el.value.length-before.length));
    try{ el.setSelectionRange(np,np); }catch(e){}
    var hint=document.getElementById("q_iban_hint");
    if(hint){
      var n=el.value.length;
      if(ibanValid(el.value)){hint.style.color="#1f7a4d";hint.textContent="✓ آيبان صحيح (24 خانة)";el.classList.remove("qd-invalid")}
      else{hint.style.color="#5a6b7d";hint.textContent=n+" / 24 خانة — تبقّى "+(24-n)+" رقم";}
    }
  };
  // block deleting the "SA" prefix
  document.addEventListener("keydown",function(e){
    var el=e.target;
    if(!el||el.id!=="q_iban")return;
    if((e.key==="Backspace"||e.key==="Delete")&&el.selectionStart<=2&&el.selectionEnd<=2){e.preventDefault()}
  },true);

  /* ---------- sidebar nav item (same look as إدارة المنتجات) ---------- */
  function findNav(){
    return document.querySelector('aside ul[class*="list-none"]')
        || document.querySelector('aside [class*="overflow-y-scroll"]')
        || document.querySelector("aside");
  }
  function buildNav(){
    var box=document.createElement("div");
    box.id=NAV_ID; box.setAttribute("dir","rtl");
    box.style.cssText="margin:4px 8px;font-family:Cairo,Tahoma,sans-serif;";

    var head=document.createElement("a");
    head.href="#"; head.title="المرجعات — QAYDAO";
    head.innerHTML='<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex:0 0 auto;font-size:15px;">\uD83D\uDD04</span>'+
      '<span style="flex:1 1 auto;text-align:start;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">المرجعات</span>'+
      '<span id="qd-ret-caret" style="flex:0 0 auto;font-size:11px;transition:transform .15s;">\u25BC</span>';
    head.style.cssText="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;text-decoration:none;cursor:pointer;direction:rtl;font-weight:600;font-size:13.5px;color:#12403d;background:linear-gradient(135deg,rgba(31,95,91,.14),rgba(18,64,61,.10));border:1px solid rgba(31,95,91,.22);transition:all .15s ease;";
    head.onmouseenter=function(){head.style.background="linear-gradient(135deg,rgba(31,95,91,.26),rgba(18,64,61,.18))"};
    head.onmouseleave=function(){head.style.background="linear-gradient(135deg,rgba(31,95,91,.14),rgba(18,64,61,.10))"};

    var sub=document.createElement("div");
    sub.id="qd-ret-sub";
    sub.style.cssText="display:none;margin-top:4px;padding-inline-start:6px;";

    function subItem(icon,label,onClick){
      var it=document.createElement("a");
      it.href="#";
      it.innerHTML='<span style="width:18px;text-align:center;flex:0 0 auto;font-size:13px;">'+icon+'</span>'+
        '<span style="flex:1 1 auto;text-align:start;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+label+'</span>';
      it.style.cssText="display:flex;align-items:center;gap:7px;margin:3px 0;padding:6px 10px;border-radius:7px;text-decoration:none;cursor:pointer;direction:rtl;font-weight:500;font-size:12.8px;color:#2b4a47;background:rgba(31,95,91,.06);transition:all .15s ease;";
      it.onmouseenter=function(){it.style.background="rgba(31,95,91,.16)"};
      it.onmouseleave=function(){it.style.background="rgba(31,95,91,.06)"};
      it.onclick=function(e){e.preventDefault();onClick()};
      return it;
    }
    sub.appendChild(subItem("\u2795","طلب إرجاع جديد",function(){openPanel()}));
    sub.appendChild(subItem("\uD83D\uDCCB","الطلبات المرفوعة",function(){
      fetchAgentName(function(nm){
        fetchAgents(function(list){
          var url="/returns/team-requests?"+
            (nm?("agent="+encodeURIComponent(nm)+"&"):"")+
            "agents="+encodeURIComponent((list||[]).join("|"));
          window.open(url,"_blank");
        });
      });
    }));

    head.onclick=function(e){
      e.preventDefault();
      var open=sub.style.display!=="none";
      sub.style.display=open?"none":"block";
      var car=document.getElementById("qd-ret-caret");
      if(car)car.style.transform=open?"rotate(0deg)":"rotate(180deg)";
    };

    box.appendChild(head); box.appendChild(sub);
    return box;
  }
  function injectNav(){
    if(document.getElementById(NAV_ID))return true;
    var nav=findNav(); if(!nav)return false;
    nav.insertBefore(buildNav(),nav.firstChild); return true;
  }

  /* ---------- styles ---------- */
  function styles(){
    if(document.getElementById("qd-ret-style"))return;
    var s=document.createElement("style");s.id="qd-ret-style";
    s.textContent=
    "#qd-ret-ov{position:fixed;inset:0;z-index:100000;background:rgba(18,30,42,.45);display:none;align-items:flex-start;justify-content:center;overflow:auto;padding:24px;font-family:Cairo,Tahoma,sans-serif}"+
    "#qd-ret-ov.show{display:flex}"+
    "#qd-ret-box{background:#fff;border-radius:16px;max-width:560px;width:100%;direction:rtl;box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden;margin:auto}"+
    ".qd-rh{background:#1f5f5b;color:#fff;padding:15px 20px;display:flex;align-items:center;gap:10px}"+
    ".qd-rh h3{font-size:16px;font-weight:700;flex:1}"+
    ".qd-rh .cid{font-size:11.5px;background:rgba(255,255,255,.2);padding:3px 9px;border-radius:999px}"+
    ".qd-rx{cursor:pointer;font-size:22px;line-height:1;background:none;border:none;color:#fff;opacity:.85}"+
    ".qd-rb{padding:18px 20px;max-height:70vh;overflow:auto}"+
    ".qd-f{margin-bottom:13px}"+
    ".qd-f label{display:block;font-size:12.5px;font-weight:600;color:#5a6b7d;margin-bottom:5px}"+
    ".qd-f input,.qd-f select{width:100%;font-family:inherit;font-size:14px;color:#1f2b3a;background:#f8fafb;border:1px solid #e4e9ee;border-radius:9px;padding:9px 12px}"+
    ".qd-f input:focus,.qd-f select:focus{outline:none;border-color:#1f5f5b;background:#fff}"+
    ".req{color:#c0392b;font-weight:700}"+
    ".qd-f input.qd-invalid,.qd-f select.qd-invalid{border-color:#c0392b;background:#fdeded}"+
    ".qd-2{display:grid;grid-template-columns:1fr 1fr;gap:10px}"+
    ".qd-rf{padding:14px 20px;border-top:1px solid #e4e9ee;display:flex;gap:10px;align-items:center}"+
    ".qd-save{background:#1f5f5b;color:#fff;border:none;border-radius:10px;padding:11px 22px;font-family:inherit;font-weight:700;font-size:14px;cursor:pointer}"+
    ".qd-save:disabled{opacity:.6;cursor:default}"+
    ".qd-cancel{background:#eef1f4;color:#5a6b7d;border:none;border-radius:10px;padding:11px 18px;font-family:inherit;font-weight:600;font-size:14px;cursor:pointer}"+
    ".qd-msg{font-size:13px;font-weight:600;margin-inline-start:auto}"+
    ".qd-msg.ok{color:#1f7a4d}.qd-msg.err{color:#c0392b}"+
    ".qd-note{background:#fff7e6;border:1px solid #f0d79b;color:#8a6417;border-radius:9px;padding:9px 12px;font-size:12px;margin-bottom:14px}"+
    /* stock-hint 2026-09-06 — تنبيه توفر الصنف في مستودع السعودية */
    ".qd-stock{display:none;background:linear-gradient(90deg,#b9770e,#e59f1a);color:#fff;border-radius:10px;padding:11px 13px;font-size:12.5px;line-height:1.75;margin:-4px 0 14px;font-weight:700}"+
    ".qd-stock.show{display:block}"+
    ".qd-stock b{font-weight:800}"+
    ".qd-stock .qd-sk{display:block;font-weight:600;opacity:.96;font-size:12px;margin-top:3px}";
    document.head.appendChild(s);
  }

  /* ---------- panel ---------- */
  function opts(arr,sel){return arr.map(function(o){return '<option'+(o===sel?' selected':'')+'>'+esc(o)+'</option>'}).join("")}
  function today(){return new Date().toISOString().slice(0,10)}

  function buildPanel(){
    styles();
    var ov=document.createElement("div");ov.id="qd-ret-ov";
    ov.innerHTML=
    '<div id="qd-ret-box">'+
      '<div class="qd-rh"><span style="font-size:18px">\uD83D\uDD04</span><h3>بيانات طلب الإرجاع — خدمة العملاء</h3>'+
        '<button class="qd-rx" id="qd-close">&times;</button></div>'+
      '<div class="qd-rb">'+
        '<div class="qd-note">تُحفظ البيانات في خدمة المرجعات المستقلة وتظهر مباشرة لصفحة المحاسب. لا ربط فعلي مع سلة في هذه المرحلة.</div>'+
        '<div class="qd-f"><label>رقم المحادثة <span class="req">*</span></label><input id="q_conv" dir="ltr" style="text-align:right" inputmode="numeric" placeholder="انسخ رقم المحادثة من الشات"></div>'+
        '<div class="qd-f"><label>اسم العميل <span class="req">*</span> <span style="color:#c0392b;font-weight:600;font-size:11.5px">— يجب كتابة الاسم الثلاثي</span></label><input id="q_name" placeholder="الاسم الأول واسم الأب واسم العائلة"></div>'+
        '<div class="qd-2"><div class="qd-f"><label>رقم طلب العميل <span class="req">*</span></label><input id="q_order" dir="ltr" style="text-align:right"></div>'+
          '<div class="qd-f"><label>مبلغ الطلب <span class="req">*</span></label><input id="q_amount" placeholder="1,250 ر.س"></div></div>'+
        '<div class="qd-stock" id="q_stock"></div>'+
        '<div class="qd-2"><div class="qd-f"><label>تاريخ إنشاء طلب الإرجاع <span class="req">*</span></label><input id="q_rdate" type="date"></div>'+
          '<div class="qd-f"><label>تاريخ طلب المنتجات الأصلي <span class="req">*</span></label><input id="q_odate" type="date"></div></div>'+
        '<div class="qd-f"><label>سبب الإرجاع <span class="req">*</span></label><select id="q_reason">'+opts(REASONS)+'</select></div>'+
        '<div class="qd-f" id="q_reason_other_wrap" style="display:none"><label>اكتب سبب الإرجاع <span class="req">*</span></label><input id="q_reason_other" placeholder="حدّد السبب…"></div>'+
        '<div class="qd-f"><label>طريقة الاسترداد <span class="req">*</span></label><select id="q_refund"><option value="">— اختر —</option>'+
          REFUND_OPTS.map(function(o){return '<option value="'+o[0]+'">'+esc(o[1])+'</option>'}).join("")+'</select></div>'+
        '<div class="qd-f" id="q_ref_wrap" style="display:none"><label id="q_ref_lbl">الرقم / المرجع <span class="req">*</span></label><input id="q_ref" dir="ltr" style="text-align:right"></div>'+
        '<div id="q_bank_wrap">'+
        '<div class="qd-f"><label>اسم البنك <span class="req">*</span></label><input id="q_bank"></div>'+
        '<div class="qd-2"><div class="qd-f"><label>الحساب البنكي <span class="req">*</span></label><input id="q_acc" dir="ltr" style="text-align:right"></div>'+
          '<div class="qd-f"><label>الآيبان (IBAN) <span class="req">*</span> <span style="color:#c0392b;font-weight:600;font-size:11.5px">— يبدأ بـ SA ويليه 22 رقم</span></label>'+
            '<input id="q_iban" dir="ltr" style="text-align:right" value="SA" maxlength="24" placeholder="SA0380000000608010167519" oninput="qdIban(this)">'+
            '<div id="q_iban_hint" style="font-size:11px;color:#5a6b7d;margin-top:4px"></div></div></div>'+
        '<div class="qd-f"><label>ملف / صورة الحساب البنكي <span class="req">*</span> <span style="color:#c0392b;font-weight:600;font-size:11.5px">— إلزامي (PDF أو صورة، حتى 10MB)</span></label>'+
          '<input id="q_file" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*" style="padding:7px 10px">'+
          '<div id="q_file_cur" style="font-size:12px;color:#5a6b7d;margin-top:5px"></div></div>'+
        '</div>'+
        '<div class="qd-f"><label>الموظف المسؤول <span class="req">*</span></label><select id="q_assignee"><option value="">— اختر —</option>'+opts(ASSIGNEES)+'</select></div>'+
      '</div>'+
      '<div class="qd-rf"><button class="qd-save" id="qd-save">حفظ طلب الإرجاع</button>'+
        '<button class="qd-cancel" id="qd-cancel">إغلاق</button>'+
        '<span class="qd-msg" id="qd-msg"></span></div>'+
    '</div>';
    document.body.appendChild(ov);
    ov.addEventListener("click",function(e){if(e.target===ov)closePanel()});
    document.getElementById("qd-close").onclick=closePanel;
    document.getElementById("qd-cancel").onclick=closePanel;
    document.getElementById("qd-save").onclick=save;
    // toggle "other reason" free-text field
    var rs=document.getElementById("q_reason");
    if(rs)rs.addEventListener("change",toggleOtherReason);
    var rf=document.getElementById("q_refund");
    if(rf)rf.addEventListener("change",toggleRefund);
    var qo=document.getElementById("q_order");
    if(qo){qo.addEventListener("blur",checkStock);qo.addEventListener("change",checkStock)}
    return ov;
  }
  // -------------------------------------------------------------------------
  // stock-hint 2026-09-06 — تنبيه توفر الصنف في مستودع السعودية
  // الغرض: قبل فتح طلب الإرجاع أصلاً، تعرف الموظفة أن الصنف موجود فعلياً في
  // مستودع جدة فتعرض على العميل الاستبدال أو التسليم الفوري بدل الاسترجاع.
  // - يُستدعى عند مغادرة حقل رقم الطلب — لا يعطّل الحفظ ولا يمنعه إطلاقاً.
  // - أي فشل (شبكة/مهلة) = لا شيء يظهر. صمت لا خطأ.
  // - الطلبات قبل يوليو 2026 غالباً بلا كود صنف ⇒ صمت طبيعي.
  // -------------------------------------------------------------------------
  var QD_STOCK_CACHE={};
  function renderStock(d){
    var box=document.getElementById("q_stock");
    if(!box)return;
    if(!d||!d.available||!d.items||!d.items.length){box.className="qd-stock";box.innerHTML="";return}
    var it=d.items[0];
    var more=d.count>1?(" \u002B"+(d.count-1)+" صنف آخر"):"";
    var loc=it.location?(" \u00B7 الموقع "+esc(it.location)):"";
    box.innerHTML='\uD83D\uDCE6 <b>هذا المنتج متوفر في مستودع السعودية</b>'+esc(more)+
      '<span class="qd-sk">'+esc(it.code||"")+' \u00B7 متاح '+esc(String(it.available))+loc+
      ' \u2014 اعرضي على العميل <b>الاستبدال أو التسليم الفوري</b> قبل إتمام الإرجاع.</span>';
    box.className="qd-stock show";
  }
  function checkStock(){
    var el=document.getElementById("q_order");
    if(!el)return;
    var on=(el.value||"").trim();
    if(!on){renderStock(null);return}
    if(QD_STOCK_CACHE[on]!==undefined){renderStock(QD_STOCK_CACHE[on]);return}
    fetch("/returns/api/stock-hint?order_number="+encodeURIComponent(on),{credentials:"same-origin"})
      .then(function(r){return r.ok?r.json():null})
      .then(function(d){QD_STOCK_CACHE[on]=d;renderStock(d)})
      .catch(function(){renderStock(null)});
  }
  function toggleOtherReason(){
    var rs=document.getElementById("q_reason"),wrap=document.getElementById("q_reason_other_wrap");
    if(!rs||!wrap)return;
    var show=(rs.value==="سبب آخر");
    wrap.style.display=show?"":"none";
    if(!show){var o=document.getElementById("q_reason_other");if(o){o.value="";o.classList.remove("qd-invalid")}}
  }
  // إظهار/إخفاء حقول الاسترداد حسب الطريقة المختارة، مع تفريغ الحقول المخفية
  // حتى لا تُرسَل بيانات لا تخص الطريقة (والسيرفر يطبّعها أيضاً — دفاع مزدوج).
  function toggleRefund(){
    var sel=document.getElementById("q_refund");
    var refw=document.getElementById("q_ref_wrap"),bankw=document.getElementById("q_bank_wrap");
    if(!sel||!refw||!bankw)return;
    var v=sel.value;
    var isRef=REFUND_REF_METHODS.indexOf(v)>=0;
    refw.style.display=isRef?"":"none";
    bankw.style.display=(v==="bank_account")?"":"none";
    var lbl=document.getElementById("q_ref_lbl");
    if(lbl)lbl.innerHTML='رقم / مرجع '+esc(refundLabel(v)||"")+' <span class="req">*</span>';
    if(!isRef){var r=document.getElementById("q_ref");if(r){r.value="";r.classList.remove("qd-invalid")}}
    if(v!=="bank_account"){
      ["q_bank","q_acc"].forEach(function(id){var e=document.getElementById(id);if(e){e.value="";e.classList.remove("qd-invalid")}});
      var ib=document.getElementById("q_iban");if(ib){ib.value="SA";ib.classList.remove("qd-invalid")}
      var ibh=document.getElementById("q_iban_hint");if(ibh){ibh.textContent="";ibh.style.color="#5a6b7d"}
      var fe=document.getElementById("q_file");if(fe){fe.value="";fe.classList.remove("qd-invalid")}
      var cur=document.getElementById("q_file_cur");if(cur)cur.innerHTML="";
    }
  }
  function getOv(){return document.getElementById("qd-ret-ov")||buildPanel()}

  function openPanel(){
    var ov=getOv();
    resetForm();
    // convenience: prefill the conversation-number field from the URL if detectable (editable)
    var cid=convId();
    var cf=document.getElementById("q_conv");
    if(cf&&cid)cf.value=cid;
    document.getElementById("q_rdate").value=today();
    toggleOtherReason();
    toggleRefund();
    fillAssignees();
    ov.classList.add("show");
  }
  function resetForm(){
    ["q_conv","q_name","q_order","q_amount","q_rdate","q_odate","q_bank","q_acc","q_reason_other","q_ref"].forEach(function(id){
      var e=document.getElementById(id);if(e){e.value="";e.classList.remove("qd-invalid")}
    });
    // IBAN resets to the "SA" prefix, not empty
    var ib=document.getElementById("q_iban");
    if(ib){ib.value="SA";ib.classList.remove("qd-invalid")}
    var ibh=document.getElementById("q_iban_hint");
    if(ibh){ibh.textContent="";ibh.style.color="#5a6b7d"}
    var rs=document.getElementById("q_reason");if(rs){rs.selectedIndex=0;rs.classList.remove("qd-invalid")}
    var rf=document.getElementById("q_refund");if(rf){rf.value="";rf.classList.remove("qd-invalid")}
    var as=document.getElementById("q_assignee");if(as){as.value="";as.classList.remove("qd-invalid")}
    var fe=document.getElementById("q_file");if(fe){fe.value="";fe.classList.remove("qd-invalid")}
    var cur=document.getElementById("q_file_cur");if(cur)cur.innerHTML="";
    var msg=document.getElementById("qd-msg");if(msg){msg.textContent="";msg.className="qd-msg"}
    var stk=document.getElementById("q_stock");if(stk){stk.innerHTML="";stk.className="qd-stock"}
    window.__qd_current_rid=null;
  }
  function closePanel(){var ov=document.getElementById("qd-ret-ov");if(ov)ov.classList.remove("show")}
  function save(){
    var g=function(id){var e=document.getElementById(id);return e?e.value.trim():""};
    var btn=document.getElementById("qd-save"),msg=document.getElementById("qd-msg");

    // ---- required-field validation ----
    var required=[["q_conv","رقم المحادثة"],["q_name","اسم العميل"],["q_order","رقم طلب العميل"],
      ["q_amount","مبلغ الطلب"],["q_rdate","تاريخ إنشاء طلب الإرجاع"],["q_odate","تاريخ الطلب الأصلي"],
      ["q_reason","سبب الإرجاع"],["q_refund","طريقة الاسترداد"],
      ["q_assignee","الموظف المسؤول"]];
    var reasonSel=g("q_reason");
    if(reasonSel==="سبب آخر")required.push(["q_reason_other","سبب الإرجاع (نص)"]);
    // حقول الاسترداد الإلزامية تعتمد على الطريقة المختارة
    var method=g("q_refund");
    var isRefMethod=REFUND_REF_METHODS.indexOf(method)>=0;
    if(isRefMethod)required.push(["q_ref","رقم / مرجع "+refundLabel(method)]);
    else if(method==="bank_account")
      required.push(["q_bank","اسم البنك"],["q_acc","الحساب البنكي"],["q_iban","الآيبان"]);
    var firstBad=null;
    required.forEach(function(f){
      var el=document.getElementById(f[0]);if(!el)return;
      var empty=!el.value||!el.value.trim();
      if(empty){el.classList.add("qd-invalid");if(!firstBad)firstBad=el}
      else{el.classList.remove("qd-invalid")}
    });
    // conversation number must be numeric
    var convVal=g("q_conv");
    var convEl=document.getElementById("q_conv");
    if(convVal&&!/^\d+$/.test(convVal)){convEl.classList.add("qd-invalid");if(!firstBad)firstBad=convEl;}
    // IBAN must be a complete Saudi IBAN: SA + 22 digits — للطريقة البنكية فقط (التحقق نفسه لم يتغير)
    var ibanEl=document.getElementById("q_iban");
    var ibanBad=(method==="bank_account")&&!ibanValid(ibanEl?ibanEl.value.trim():"");
    if(ibanBad&&ibanEl){ibanEl.classList.add("qd-invalid");if(!firstBad)firstBad=ibanEl;}
    if(firstBad){
      msg.className="qd-msg err";
      msg.textContent=(ibanBad&&firstBad===ibanEl)
        ? "الآيبان غير مكتمل — يجب أن يكون SA يليه 22 رقماً (24 خانة)."
        : "يرجى تعبئة جميع الحقول الإلزامية (وأرقام صحيحة لرقم المحادثة).";
      firstBad.focus();return;
    }

    var reasonFinal=(reasonSel==="سبب آخر")?g("q_reason_other"):reasonSel;
    var fileEl=document.getElementById("q_file");
    var file=(fileEl&&fileEl.files&&fileEl.files.length)?fileEl.files[0]:null;
    // ملف الحساب البنكي إلزامي للطريقة البنكية فقط — لا معنى له مع تابي/تمارا/مدفوع.
    if(!file&&method==="bank_account"){
      msg.className="qd-msg err";
      msg.textContent="يجب إرفاق ملف أو صورة الحساب البنكي.";
      if(fileEl){fileEl.classList.add("qd-invalid");fileEl.focus();fileEl.scrollIntoView({behavior:"smooth",block:"center"})}
      return;
    }
    if(fileEl)fileEl.classList.remove("qd-invalid");
    if(file&&file.size>10*1024*1024){msg.className="qd-msg err";msg.textContent="حجم الملف يتجاوز 10 ميجابايت.";return}

    btn.disabled=true;msg.className="qd-msg";msg.textContent="جارٍ الحفظ…";
    var body={conversation_id:parseInt(convVal,10),customer_name:g("q_name"),order_number:g("q_order"),
      order_amount:g("q_amount"),return_created_at:g("q_rdate"),original_order_at:g("q_odate"),
      reason:reasonFinal,refund_method:method,refund_reference:(isRefMethod?g("q_ref"):""),
      bank_name:g("q_bank"),bank_account:g("q_acc"),iban:g("q_iban"),
      assignee:g("q_assignee"),created_by:agentName()};
    fetch(API+"/requests",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
      .then(function(r){
        if(!r.ok)return r.json().then(function(e){throw {msg:(e&&e.detail)||"تعذّر حفظ الطلب"}},function(){throw 0});
        return r.json();
      })
      .then(function(saved){
        window.__qd_current_rid=saved.id;
        if(!file){throw {ok:true}}
        msg.textContent="جارٍ رفع الملف…";
        var fd=new FormData();fd.append("file",file);
        return fetch(API+"/requests/"+saved.id+"/attachment",{method:"POST",body:fd})
          .then(function(r){if(!r.ok)return r.json().then(function(e){throw {msg:(e&&e.detail)||"تعذّر رفع الملف"}});return r.json()});
      })
      .then(function(){
        resetForm();
        document.getElementById("q_rdate").value=today();toggleOtherReason();
        var m=document.getElementById("qd-msg");m.className="qd-msg ok";
        m.textContent="تم الإرسال ✓ سيظهر لدى المحاسب. النموذج جاهز لطلب جديد.";
        btn.disabled=false;
      })
      .catch(function(e){
        if(e&&e.ok){
          resetForm();
          document.getElementById("q_rdate").value=today();toggleOtherReason();
          var m=document.getElementById("qd-msg");m.className="qd-msg ok";
          m.textContent="تم الإرسال ✓ سيظهر لدى المحاسب. النموذج جاهز لطلب جديد.";
          btn.disabled=false;return;
        }
        msg.className="qd-msg err";msg.textContent=(e&&e.msg)||"تعذّر الحفظ، حاول مجدداً.";btn.disabled=false;
      });
  }

  /* ---------- boot ---------- */
  function tryInject(n){if(injectNav())return;if(n>0)setTimeout(function(){tryInject(n-1)},400)}
  function start(){
    tryInject(15);
    try{ fetchAgentName(function(){}); }catch(e){}  // warm the name cache early
    try{ fetchAgents(function(){}); }catch(e){}     // warm the agents list early
    var last=location.href;
    new MutationObserver(function(){
      if(location.href!==last){last=location.href;setTimeout(function(){tryInject(10)},500)}
      if(!document.getElementById(NAV_ID))tryInject(3);
    }).observe(document.documentElement,{subtree:true,childList:true});
  }
  if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",function(){setTimeout(start,1200)})}
  else{setTimeout(start,1200)}
})();
