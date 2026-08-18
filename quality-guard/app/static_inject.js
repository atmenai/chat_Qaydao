/* QAYDAO Quality Guard — Reports menu injector + in-conversation notes toggle.
   Loaded via one <script> tag. */
(function () {
  "use strict";
  var QG_BASE = "/quality-guard";
  var FLAG = "data-qg-injected";

  function onReportsPage() {
    return /\/reports(\/|$)/.test(location.pathname);
  }

  function findContainer() {
    var links = document.querySelectorAll('a[href*="/reports/"]');
    if (!links.length) return null;
    var first = links[0];
    var parent = first.parentElement;
    for (var i = 0; i < 4 && parent; i++) {
      if (parent.querySelectorAll('a[href*="/reports/"]').length >= 2) {
        return { container: parent, sample: first };
      }
      parent = parent.parentElement;
    }
    return { container: first.parentElement, sample: first };
  }

  function makeItem(label, sample, onClick) {
    var node = sample.cloneNode(true);
    node.removeAttribute("href");
    node.setAttribute("role", "button");
    node.style.cursor = "pointer";
    var t = node.querySelector("span span") || node.querySelector("span") || node;
    t.textContent = label;
    node.classList.remove("router-link-active", "router-link-exact-active");
    node.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      onClick();
      document.querySelectorAll(".qg-active").forEach(function (n) { n.classList.remove("qg-active"); });
      node.classList.add("qg-active");
    });
    node.setAttribute("data-qg-item", label);
    return node;
  }

  function ensureStyles() {
    if (document.getElementById("qg-inject-style")) return;
    var st = document.createElement("style");
    st.id = "qg-inject-style";
    st.textContent =
      ".qg-active{background:rgba(31,111,235,.12)!important;border-radius:8px}" +
      "#qg-frame-wrap{position:fixed;inset:0;z-index:50;display:none;background:#fff}" +
      "#qg-frame-wrap.show{display:block}" +
      "#qg-frame-wrap iframe{width:100%;height:100%;border:0}" +
      "#qg-frame-close{position:absolute;inset-inline-end:14px;top:10px;z-index:51;background:#1f6feb;color:#fff;border:0;border-radius:8px;padding:6px 12px;cursor:pointer;font-family:inherit}" +
      /* hide QG notes from the conversation view (display only, never deleted) */
      "body.qg-notes-hidden [data-qg-note-row]{display:none!important}" +
      /* sticky toolbar anchored INSIDE the conversation message area */
      ".qg-notes-toolbar{position:sticky;top:0;z-index:20;display:flex;justify-content:flex-end;" +
        "padding:6px 10px;background:linear-gradient(#fff,rgba(255,255,255,.92));backdrop-filter:saturate(1.2) blur(2px);" +
        "border-bottom:1px solid #eceef1}" +
      "#qg-toggle-notes{cursor:pointer;border:1px solid #d7dbe0;background:#fff;color:#3c4858;border-radius:8px;" +
        "padding:5px 12px;font-family:inherit;font-size:12.5px;font-weight:600;line-height:1.4;white-space:nowrap;" +
        "box-shadow:0 1px 2px rgba(0,0,0,.04);transition:background .15s,border-color .15s}" +
      "#qg-toggle-notes:hover{background:#f5f7f9}" +
      "#qg-toggle-notes.qg-toggle-on{background:#fff8e8;border-color:#f0c36d;color:#9a6700}" +
      "#qg-toggle-notes .qg-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#1f6feb;margin-inline-end:6px;vertical-align:middle}" +
      "#qg-toggle-notes.qg-toggle-on .qg-dot{background:#e0a106}";
    document.head.appendChild(st);
  }

  function showQG(tab) {
    ensureStyles();
    var wrap = document.getElementById("qg-frame-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "qg-frame-wrap";
      var close = document.createElement("button");
      close.id = "qg-frame-close";
      close.textContent = "\u2715 \u0625\u063a\u0644\u0627\u0642";
      close.addEventListener("click", function () { wrap.classList.remove("show"); });
      var frame = document.createElement("iframe");
      frame.id = "qg-frame";
      wrap.appendChild(close);
      wrap.appendChild(frame);
      document.body.appendChild(wrap);
    }
    document.getElementById("qg-frame").src = QG_BASE + "/?tab=" + (tab || "reports");
    wrap.classList.add("show");
  }

  /* ---------- in-conversation Quality-Guard notes toggle ---------- */
  var QG_NOTE_MARK = "\u062a\u0646\u0628\u064a\u0647 \u062c\u0648\u062f\u0629 \u062f\u0627\u062e\u0644\u064a"; // «تنبيه جودة داخلي»
  var LBL_HIDE = "\u0625\u062e\u0641\u0627\u0621 \u062a\u0646\u0628\u064a\u0647\u0627\u062a \u0627\u0644\u062c\u0648\u062f\u0629"; // إخفاء تنبيهات الجودة
  var LBL_SHOW = "\u0625\u0638\u0647\u0627\u0631 \u062a\u0646\u0628\u064a\u0647\u0627\u062a \u0627\u0644\u062c\u0648\u062f\u0629"; // إظهار تنبيهات الجودة

  function isConversationView() {
    return /\/(conversations?|inbox|custom_view|mentions|unattended|label|team)\/?/.test(location.pathname) &&
           !onReportsPage();
  }

  // Precisely tag ONLY Quality-Guard note bubbles (never the whole conversation).
  // A QG note is a private/internal note whose text contains the QG marker.
  // We tag the SMALLEST wrapper that represents that single message, with a hard
  // guard: the wrapper must contain exactly ONE QG marker (else it's a big container).
  function _markerCount(el) {
    var html = el.textContent || "";
    var idx = 0, n = 0;
    while (true) {
      idx = html.indexOf(QG_NOTE_MARK, idx);
      if (idx === -1) break;
      n++; idx += QG_NOTE_MARK.length;
    }
    return n;
  }

  function tagQgNotesAndFindArea() {
    // 1) find the leaf elements that directly contain the QG marker text
    var all = document.querySelectorAll("div,li,article,section,p,span");
    var leaves = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var txt = el.textContent || "";
      if (txt.indexOf(QG_NOTE_MARK) === -1) continue;
      // a "leaf" carrier: none of its children individually still contains the marker
      var childHasIt = false;
      for (var c = 0; c < el.children.length; c++) {
        if ((el.children[c].textContent || "").indexOf(QG_NOTE_MARK) > -1) { childHasIt = true; break; }
      }
      if (!childHasIt) leaves.push(el);
    }
    // 2) for each leaf, climb to the single-message wrapper — but STOP before any
    //    element that would swallow more than this one note (guard against big containers)
    var tagged = [];
    for (var j = 0; j < leaves.length; j++) {
      var row = leaves[j];
      var chosen = row;
      var p = row.parentElement;
      for (var k = 0; k < 8 && p; k++) {
        // never climb into an element that holds MORE than one QG marker -> would hide siblings
        if (_markerCount(p) > 1) break;
        // never climb into an obvious whole-conversation / list container
        var cls = (p.className || "") + "";
        if (/conversation-panel|messages-?wrap|messages-?list|conversation-?wrap|conversation__panel|inbox|ProseMirror-host/i.test(cls)) break;
        chosen = p;
        p = p.parentElement;
      }
      if (chosen && !chosen.getAttribute("data-qg-note-row")) {
        chosen.setAttribute("data-qg-note-row", "1");
      }
      if (chosen) tagged.push(chosen);
    }
    // 3) find the scrollable messages area (to host the sticky toolbar)
    var area = null;
    if (tagged.length) {
      var q = tagged[0];
      for (var d = 0; d < 14 && q; d++) {
        var oy = "";
        try { oy = getComputedStyle(q).overflowY; } catch (e) {}
        if ((oy === "auto" || oy === "scroll") && (q.scrollHeight || 0) > (q.clientHeight || 0) + 20) { area = q; break; }
        q = q.parentElement;
      }
    }
    if (!area) {
      area = document.querySelector(".conversation-panel, .messages-wrap, [class*='conversationPanel'], ul.conversation-panel");
    }
    return area;
  }

  function buildToggleButton() {
    var btn = document.createElement("button");
    btn.id = "qg-toggle-notes";
    btn.type = "button";
    var hidden = document.body.classList.contains("qg-notes-hidden");
    btn.innerHTML = '<span class="qg-dot"></span><span class="qg-lbl"></span>';
    btn.querySelector(".qg-lbl").textContent = hidden ? LBL_SHOW : LBL_HIDE;
    if (hidden) btn.classList.add("qg-toggle-on");
    btn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      var nowHidden = document.body.classList.toggle("qg-notes-hidden");
      tagQgNotesAndFindArea();
      btn.querySelector(".qg-lbl").textContent = nowHidden ? LBL_SHOW : LBL_HIDE;
      btn.classList.toggle("qg-toggle-on", nowHidden);
    });
    return btn;
  }

  function injectToggle() {
    if (!isConversationView()) return;
    var area = tagQgNotesAndFindArea();
    if (!area) return; // no conversation messages area yet
    // already present and still attached?
    var existing = document.getElementById("qg-toggle-notes");
    if (existing && document.body.contains(existing)) return;
    // build a sticky toolbar pinned to the top of the messages area, INSIDE the chat box
    var bar = document.createElement("div");
    bar.className = "qg-notes-toolbar";
    bar.setAttribute("data-qg-toolbar", "1");
    bar.appendChild(buildToggleButton());
    // insert as the first child of the messages area so it sticks at the top inside the box
    if (area.firstChild) area.insertBefore(bar, area.firstChild);
    else area.appendChild(bar);
  }

  /* ---------- reports submenu items ---------- */
  function inject() {
    if (!onReportsPage()) return;
    var found = findContainer();
    if (!found || !found.container) return;
    if (found.container.getAttribute(FLAG)) return;
    var a = makeItem("\u062a\u0642\u0627\u0631\u064a\u0631 \u0627\u0644\u062c\u0648\u062f\u0629", found.sample, function () { showQG("reports"); });
    var b = makeItem("\u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u062c\u0648\u062f\u0629", found.sample, function () { showQG("settings"); });
    found.container.appendChild(a);
    found.container.appendChild(b);
    found.container.setAttribute(FLAG, "1");
  }

  function tick() {
    try { ensureStyles(); } catch (e) {}
    try { inject(); } catch (e) {}
    try { injectToggle(); } catch (e) {}
  }
  function start() {
    new MutationObserver(tick).observe(document.body, { childList: true, subtree: true });
    setInterval(tick, 1500);
    tick();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else { start(); }
})();
