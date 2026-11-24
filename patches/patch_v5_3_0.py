#!/usr/bin/env python3
"""
patch_v5_3_0.py — Ukrainian localisation (v5.2.2 → v5.3.0)

Run from the repository root:

    python3 patches/patch_v5_3_0.py

Touches:
  Ayurfood/index.html                 i18n engine, language switch, t()/tn() at every
                                      interpolated string, locale-aware dates, lang sent
                                      to analyse/guide, Ukrainian food names
  Ayurfood/sw.js                      precaches /i18n/uk.js, bumps the cache name
  Ayurfood/netlify.toml               proxies /uk/food/* to the content site
  Ayurfood/netlify/functions/analyse.js   lang=uk → Ukrainian prose, Ukrainian claim patterns
  Ayurfood/netlify/functions/guide.js     lang=uk → Ukrainian prose, Ukrainian claim patterns

New files shipped next to this script (upload them in the same commit):
  Ayurfood/i18n/uk.js                 the Ukrainian dictionary
  Ayurfood/privacy-uk.html            Ukrainian privacy notice

Every edit is assertion-gated: the script refuses to run against a file that is
not exactly the expected v5.2.2 source, and writes nothing unless every edit in
every file applies.
"""
import io, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = lambda *a: os.path.join(ROOT, 'Ayurfood', *a)

def read(p):
    with io.open(p, encoding='utf-8') as f: return f.read()

class Patch:
    def __init__(self, path):
        self.path, self.src = path, read(path)
    def rep(self, old, new, count=1):
        n = self.src.count(old)
        if n != count:
            sys.exit('ABORT %s: expected %d × %r, found %d' % (os.path.basename(self.path), count, old[:90], n))
        self.src = self.src.replace(old, new)
    def rx(self, pattern, new, count):
        s, n = re.subn(pattern, new, self.src)
        if n != count:
            sys.exit('ABORT %s: regex %r matched %d, expected %d' % (os.path.basename(self.path), pattern, n, count))
        self.src = s

# ════════════════════════════════════════════════════════════════════════════
# index.html
# ════════════════════════════════════════════════════════════════════════════
h = Patch(P('index.html'))
if 'v5.2.2' not in h.src or 'AFC_LANG' in h.src:
    sys.exit('ABORT index.html: not the v5.2.2 source (or already patched)')

# ── 1. The engine, first thing in <head> so it precedes every other script.
ENGINE = r'''<meta charset="UTF-8">
  <!-- ===== v5.3.0 · i18n — language pick + dictionary load (must run first) ===== -->
  <script>
  (function () {
    var L = null;
    try {
      var q = new URLSearchParams(location.search).get('lang');
      if (q === 'uk' || q === 'en') localStorage.setItem('afc_lang', q);
    } catch (e) {}
    try { L = localStorage.getItem('afc_lang'); } catch (e) {}
    if (L !== 'uk' && L !== 'en') {
      var ls = [].concat(navigator.languages || [], navigator.language || []);
      L = ls.some(function (x) { return /^uk(-|$)/i.test(String(x)); }) ? 'uk' : 'en';
    }
    window.AFC_LANG = L;
    window.AFC_LOCALE = L === 'uk' ? 'uk-UA' : undefined;
    document.documentElement.lang = L;
    // Synchronous on purpose: the dictionary must exist before the first paint,
    // and only Ukrainian visitors pay for it. Same origin, so it is not subject
    // to Chrome's cross-origin document.write intervention.
    if (L === 'uk') document.write('<script src="/i18n/uk.js?v=5.3.0"><\/script>');
  })();
  </script>
  <script>
  /* t(en, vars)              → translated string, {name} placeholders filled
     tn(n, one, many, vars)   → plural-aware; Ukrainian dictionary holds [one, few, many]
     tr(text)                 → dictionary + pattern lookup for free text and data
     The DOM pass translates every text node, placeholder/title/aria-label and
     known inline-HTML block as it is inserted, so plain literals need no t(). */
  (function () {
    var U = (window.AFC_LANG === 'uk' && window.AFC_UK) || null;
    var D = (U && U.t) || {}, H = (U && U.h) || {}, RX = (U && U.rx) || [], F = (U && U.foods) || {};
    var on = !!U;
    function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
    function sub(s, v) {
      return v ? String(s).replace(/\{(\w+)\}/g, function (m, k) { return v[k] != null ? v[k] : m; }) : String(s);
    }
    function ukForm(n) {
      n = Math.abs(Math.round(n)) % 100; var n1 = n % 10;
      if (n > 10 && n < 20) return 2; if (n1 === 1) return 0; if (n1 > 1 && n1 < 5) return 1; return 2;
    }
    // A key may carry a context prefix ("hunger|Light") where one English word
    // needs two Ukrainian ones; English falls back to the text after the bar.
    window.t = function (en, v) {
      if (on) { var u = D[en]; if (typeof u === 'string') return sub(u, v); }
      return sub(String(en).replace(/^[a-z]+\|/, ''), v);
    };
    window.tn = function (n, one, many, v) {
      v = Object.assign({ n: n }, v || {});
      if (on) {
        var u = D[many];
        if (Array.isArray(u)) return sub(u[ukForm(n)], v);
        if (typeof u === 'string') return sub(u, v);
      }
      return sub(n === 1 ? one : many, v);
    };
    window.tr = function (s) {
      if (!on || s == null) return s;
      var k = norm(s); if (!k) return s;
      var u = D[k]; if (typeof u === 'string') return u;
      for (var i = 0; i < RX.length; i++) {
        var m = k.match(RX[i][0]);
        if (m) return typeof RX[i][1] === 'function' ? RX[i][1].apply(null, m) : k.replace(RX[i][0], RX[i][1]);
      }
      return s;
    };
    /** Ukrainian name of a reference food, by slug; the English name otherwise. */
    window.afcFoodName = function (slug, fallback) {
      return (on && slug && F[slug]) || fallback || slug || '';
    };
    window.afcSetLang = function (l) {
      try { localStorage.setItem('afc_lang', l === 'uk' ? 'uk' : 'en'); } catch (e) {}
      location.reload();
    };
    if (!on) return;

    var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1, svg: 1, SVG: 1 };
    var ATTRS = ['placeholder', 'title', 'aria-label'];
    function doText(n) {
      var v = n.nodeValue;
      if (!v || !/[A-Za-z]/.test(v)) return;
      var r = window.tr(v);
      if (r !== v && r != null) {
        var lead = v.match(/^\s*/)[0], trail = v.match(/\s*$/)[0];
        if (/^[,.;:]/.test(r)) lead = '';   // "$3.99" + ", а надалі…" — no space before the comma
        var nv = lead + r + trail;
        if (nv !== v) n.nodeValue = nv;
      }
    }
    function doHref(el) {
      if (el.tagName !== 'A') return;
      var h = el.getAttribute('href');
      if (h && h.indexOf('/food/') === 0) el.setAttribute('href', '/uk' + h);
    }
    function doAttrs(el) {
      for (var i = 0; i < ATTRS.length; i++) {
        var a = el.getAttribute(ATTRS[i]);
        if (a && /[A-Za-z]/.test(a)) { var r = window.tr(a); if (r !== a) el.setAttribute(ATTRS[i], r); }
      }
    }
    function walk(el) {
      if (el.nodeType === 3) { doText(el); return; }
      if (el.nodeType !== 1) return;
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') { doAttrs(el); return; }
      if (SKIP[el.tagName]) return;
      doHref(el);
      if (el.hasAttribute('data-no-i18n')) return;
      doAttrs(el);
      if (el.firstElementChild) {
        var k = norm(el.innerHTML);
        if (k.length < 1200 && typeof H[k] === 'string') { el.innerHTML = H[k]; return; }
      }
      for (var c = el.firstChild; c; c = c.nextSibling) walk(c);
    }
    window.afcTranslateTree = walk;
    document.addEventListener('DOMContentLoaded', function () {
      walk(document.body);
      new MutationObserver(function (ms) {
        for (var i = 0; i < ms.length; i++) {
          var m = ms[i];
          if (m.type === 'characterData') doText(m.target);
          else if (m.type === 'attributes') doAttrs(m.target);
          else for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]);
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true,
                                  attributes: true, attributeFilter: ATTRS });
      // Ukrainian visitors get the Ukrainian privacy notice.
      document.querySelectorAll('a[href="/privacy.html"]').forEach(function (a) { a.setAttribute('href', '/privacy-uk.html'); });
    });
    // Native dialogs are not DOM: route them through the dictionary too.
    var _a = window.alert, _c = window.confirm;
    window.alert = function (s) { return _a.call(window, window.tr(s)); };
    window.confirm = function (s) { return _c.call(window, window.tr(s)); };
  })();
  </script>'''
h.rep('<meta charset="UTF-8">', ENGINE)

# ── 2. Language switch: header, and the login page for visitors without an account.
LANG_BTN = ('<button class="btn btn-outline btn-sm" data-no-i18n onclick="afcSetLang(AFC_LANG===\'uk\'?\'en\':\'uk\')" '
            'aria-label="Language · Мова" style="border-radius:22px;padding:7px 11px;font-size:12px;line-height:1;margin-right:6px;font-weight:600;letter-spacing:.5px;">'
            '<script>document.write(AFC_LANG===\'uk\'?\'EN\':\'УК\')</script></button>\n      ')
h.rep('<div class="hdr-right">\n      <button class="btn btn-outline btn-sm" onclick="goTab(\'account\')"',
      '<div class="hdr-right">\n      ' + LANG_BTN + '<button class="btn btn-outline btn-sm" onclick="goTab(\'account\')"')
h.rep('<p style="font-size:10px;color:#aaa;text-align:center;margin-top:8px;">v5.2.2</p>',
      '<p data-no-i18n style="text-align:center;margin-top:14px;font-size:12px;">'
      '<a href="#" onclick="afcSetLang(\'en\');return false;" style="color:rgba(251,248,243,0.75);">English</a>'
      ' · <a href="#" onclick="afcSetLang(\'uk\');return false;" style="color:rgba(251,248,243,0.75);">Українська</a></p>\n'
      '    <p style="font-size:10px;color:#aaa;text-align:center;margin-top:8px;">v5.3.0</p>')
h.rep('AyurFood v5.2.2 · <a href="#" style="color:var(--gold);">Privacy</a>',
      'AyurFood v5.3.0 · <a href="/privacy.html" target="_blank" rel="noopener" style="color:var(--gold);">Privacy</a>')
h.rep('By continuing you agree to our <a href="#">Terms</a> and <a href="#">Privacy Policy</a>.',
      'By continuing you agree to our <a href="#">Terms</a> and <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.')
h.rep('<div class="menu-item" onclick="clearJournal()">',
      '<div class="menu-item" data-no-i18n onclick="afcSetLang(AFC_LANG===\'uk\'?\'en\':\'uk\')">\n'
      '          <span class="menu-icon">🌐</span>\n'
      '          <span class="menu-label">Language · Мова: <script>document.write(AFC_LANG===\'uk\'?\'Українська\':\'English\')</script></span>\n'
      '          <span class="menu-arrow">›</span>\n'
      '        </div>\n'
      '        <div class="menu-item" onclick="clearJournal()">')

# ── 3. Dates and times follow the chosen language, not only the browser's.
h.rep('toLocaleDateString(undefined', 'toLocaleDateString(AFC_LOCALE', 6)
h.rep('toLocaleTimeString(undefined', 'toLocaleTimeString(AFC_LOCALE', 1)
h.rep("new Date(h.ts).toLocaleString() : ''", "new Date(h.ts).toLocaleString(AFC_LOCALE) : ''")

# ── 4. Data localised once, in place, before anything renders. Keys and enum
#    values (Sweet, Heating, Excellent…) are never touched — only display text.
LOCALISE = r'''
// ══════════════════════════════════════════
// v5.3.0 · LOCALISED DATA
// ══════════════════════════════════════════
// Display strings in the data tables are swapped for the dictionary's, in place,
// so every join, chip and concatenation downstream is already Ukrainian. Object
// keys, enum values and anything compared in code are left exactly as they are.
function afcLocaliseData() {
  if (window.AFC_LANG !== 'uk' || !window.AFC_UK) return;
  Object.keys(DOSHA).forEach(k => {
    const d = DOSHA[k];
    d.name = tr(d.name); d.element = tr(d.element); d.guidance = tr(d.guidance);
    d.qualities = d.qualities.map(tr);
  });
  Object.keys(DN).forEach(k => { DN[k] = tr(DN[k]); });
  Object.keys(AFC_SEASON_NAME).forEach(k => { AFC_SEASON_NAME[k] = tr(AFC_SEASON_NAME[k]); });
  AYUR_HINTS.forEach(x => { x.t = tr(x.t); x.d = tr(x.d); });
  AFC_MEALS.forEach(m => { m.name = tr(m.name); });
  Object.keys(AFC_SITUATIONS).forEach(k => { const s = AFC_SITUATIONS[k]; s.q = tr(s.q); s.line = tr(s.line); });
  for (let i = 0; i < AFC_ASK_SEEDS.length; i++) AFC_ASK_SEEDS[i] = tr(AFC_ASK_SEEDS[i]);
  Object.keys(AFC_FIXES).forEach(k => AFC_FIXES[k].forEach(f => { f.t = tr(f.t); }));
  [AFC_TASTE_FX, AFC_VIRYA_FX, AFC_VIPAKA_FX].forEach(m => Object.keys(m).forEach(k => { m[k].w = tr(m[k].w); }));
  Object.keys(AFC_BREATH).forEach(k => { AFC_BREATH[k].tag = tr(AFC_BREATH[k].tag); });
}
afcLocaliseData();

/** A food row's display name: Ukrainian by slug when available. */
function afcRowName(r) { return r ? afcFoodName(r.slug, r.name) : ''; }
/** A taste list such as "Sweet, Astringent", element by element. */
function afcTasteList(s) { return String(s || '').split(/\s*,\s*/).filter(Boolean).map(tr).join(', '); }
</script>'''
# Appended at the end of the main script, after every data table exists.
h.rep("function showError(msg, color) {\n  showLoginStatus(msg, color);\n}\n</script>",
      "function showError(msg, color) {\n  showLoginStatus(msg, color);\n}\n" + LOCALISE)

# ── 5. Interpolated and concatenated strings.
E = h.rep
E("badge.innerHTML = `<span class=\"sub-badge trial\">⏳ Trial — ${d} day${d!==1?'s':''} left</span>`;",
  "badge.innerHTML = `<span class=\"sub-badge trial\">⏳ ${tn(d, 'Trial — {n} day left', 'Trial — {n} days left')}</span>`;")
E("badge.innerHTML = `<span class=\"sub-badge expired\">Free plan — ${afcAnalysesLeft()} of ${AFC_FREE_PER_DAY} analyses left today</span>`;",
  "badge.innerHTML = `<span class=\"sub-badge expired\">${t('Free plan — {a} of {b} analyses left today', { a: afcAnalysesLeft(), b: AFC_FREE_PER_DAY })}</span>`;")
E("d + ' day' + (d === 1 ? '' : 's') + ' of free access remaining \\u00b7 no card needed' +",
  "tn(d, '{n} day of free access remaining · no card needed', '{n} days of free access remaining · no card needed') +")
E("? `${days} day${days!==1?'s':''} of free access \\u2014 nothing saved yet`\n      : `${days} day${days!==1?'s':''} left in free trial`;",
  "? tn(days, '{n} day of free access — nothing saved yet', '{n} days of free access — nothing saved yet')\n      : tn(days, '{n} day left in free trial', '{n} days left in free trial');")
E("showToast('Checkout error: ' + (data.error || 'Unknown error'));",
  "showToast(t('Checkout error:') + ' ' + tr(data.error || 'Unknown error'));")
E("showToast('Checkout failed: ' + err.message);", "showToast(t('Checkout failed:') + ' ' + err.message);")
E("detail.textContent = endsOn ? 'Complimentary access until ' + endsOn : 'Complimentary access';",
  "detail.textContent = endsOn ? t('Complimentary access until {d}', { d: endsOn }) : t('Complimentary access');")
E("? 'Cancelled — access continues until ' + endsOn\n        : 'Cancelled — access continues to the end of your paid period';",
  "? t('Cancelled — access continues until {d}', { d: endsOn })\n        : t('Cancelled — access continues to the end of your paid period');")
E("detail.textContent = endsOn ? 'Renews automatically on ' + endsOn : 'Renews automatically';",
  "detail.textContent = endsOn ? t('Renews automatically on {d}', { d: endsOn }) : t('Renews automatically');")
E("detail.textContent = 'Free trial — no payment method on file · '\n                       + d + ' day' + (d !== 1 ? 's' : '') + ' left';",
  "detail.textContent = t('Free trial — no payment method on file') + ' · '\n                       + tn(d, '{n} day left', '{n} days left');")
E("'Cancel your subscription?\\n\\n' +\n    'You will keep full access until the end of the period you have already paid for. ' +\n    'You will not be charged again.'",
  "t('Cancel your subscription?') + '\\n\\n' +\n    t('You will keep full access until the end of the period you have already paid for. You will not be charged again.')")
E("? ('Already cancelled' + (until ? ' — access until ' + until : ''))\n      : ('✓ Cancelled' + (until ? ' — access until ' + until : '')));",
  "? (t('Already cancelled') + (until ? ' — ' + t('access until {d}', { d: until }) : ''))\n      : ('✓ ' + t('Cancelled') + (until ? ' — ' + t('access until {d}', { d: until }) : '')));")
E("showToast('Could not check subscription — ' + e.message);",
  "showToast(t('Could not check subscription') + ' — ' + e.message);")
E("const tag    = tint ? tint.name + ' note' : 'For every constitution';",
  "const tag    = tint ? t('{d} note', { d: tint.name }) : t('For every constitution');")
E("alert(`Please answer at least 10 questions (${filled.length}/20 answered).`);",
  "alert(t('Please answer at least 10 questions ({n}/20 answered).', { n: filled.length }));")
E("'Recalculate ' + eligible.length + ' saved journal entr' + (many ? 'ies' : 'y') +\n    ' for a ' + name + ' constitution?\\n\\n' +\n    'The original analysis of each food is reused \\u2014 nothing is sent for re-analysis. ' +\n    'Choose Cancel to keep the scores as they were recorded.'",
  "tn(eligible.length, 'Recalculate {n} saved journal entry for a {d} constitution?', 'Recalculate {n} saved journal entries for a {d} constitution?', { d: name }) + '\\n\\n' +\n    t('The original analysis of each food is reused — nothing is sent for re-analysis. Choose Cancel to keep the scores as they were recorded.')")
E("try { showToast('Journal recalculated for ' + name); } catch (e) {}",
  "try { showToast(t('Journal recalculated for {d}', { d: name })); } catch (e) {}")
E("<div class=\"dres-name\" style=\"color:${d.color}\">${d.name} Prakriti</div>",
  "<div class=\"dres-name\" style=\"color:${d.color}\">${t('{d} Prakriti', { d: d.name })}</div>")
E("${answered>0?'Based on '+answered+'/20 questions':'Manually selected'}",
  "${answered>0?t('Based on {n}/20 questions', { n: answered }):t('Manually selected')}")
E("alert('Please enter a food name or take a photo.');", "alert(t('Please enter a food name or take a photo.'));")
E("alert('Analysis failed. Please try again.\\n\\n' + (e.message||String(e)));",
  "alert(t('Analysis failed. Please try again.') + '\\n\\n' + tr(e.message||String(e)));")
E("body: JSON.stringify({ foodName, imageB64: b64, dosha })",
  "body: JSON.stringify({ foodName, imageB64: b64, dosha, lang: AFC_LANG })")
E("'Read the full Ayurvedic profile of ' + afcEsc(hit.name) + ' ↗</a>';",
  "afcEsc(t('Read the full Ayurvedic profile of {f}', { f: afcFoodName(hit.slug, hit.name) })) + ' ↗</a>';")
E("? '<div style=\"font-size:11px;color:#9A8B78;margin-top:10px;\">' + d + ' day' +\n          (d === 1 ? '' : 's') + ' of free access remaining</div>'",
  "? '<div style=\"font-size:11px;color:#9A8B78;margin-top:10px;\">' +\n          tn(d, '{n} day of free access remaining', '{n} days of free access remaining') + '</div>'")
E("const summary = n + (n===1 ? ' entry' : ' entries') + (good ? ' · ' + good + ' ✓' : '');",
  "const summary = tn(n, '{n} entry', '{n} entries') + (good ? ' · ' + good + ' ✓' : '');")
E("margin-top:3px;\">meal${total===1?'':'s'}</div>",
  "margin-top:3px;\">${tn(total, 'meal', 'meals')}</div>")
E("const name = history[i]?.food || 'this entry';", "const name = history[i]?.food || t('this entry');")
E("<div style=\"font-size:13px;color:#7A6B58;margin-bottom:20px;\">\"${name}\" will be permanently removed from your journal.</div>",
  "<div style=\"font-size:13px;color:#7A6B58;margin-bottom:20px;\">${afcEsc(t('\"{f}\" will be permanently removed from your journal.', { f: name }))}</div>")
E("if (!confirm('Clear all journal entries?')) return;", "if (!confirm(t('Clear all journal entries?'))) return;")
E("if (h < 5)  return 'Still awake';\n  if (h < 12) return 'Good morning';\n  if (h < 18) return 'Good afternoon';\n  return 'Good evening';",
  "if (h < 5)  return t('Still awake');\n  if (h < 12) return t('Good morning');\n  if (h < 18) return t('Good afternoon');\n  return t('Good evening');")
E("if (heating > cooling) bits.push('warming overall');\n  else if (cooling > heating) bits.push('cooling overall');",
  "if (heating > cooling) bits.push(t('warming overall'));\n  else if (cooling > heating) bits.push(t('cooling overall'));")
E("if (e <= -0.35) bits.push('settles ' + DN[d]);\n    else if (e >= 0.35) bits.push('raises ' + DN[d]);",
  "if (e <= -0.35) bits.push(t('settles {d}', { d: DN[d] }));\n    else if (e >= 0.35) bits.push(t('raises {d}', { d: DN[d] }));")
E("chips('weight', [['light','Light'],['normal','Normal'],['hearty','Hungry']])",
  "chips('weight', [['light',t('hunger|Light')],['normal',t('hunger|Normal')],['hearty',t('hunger|Hungry')]])")
E("'<div class=\"prop\"><div class=\"prop-l\">Vipāka</div><div class=\"prop-v\">' + afcEsc(r.vipaka || '—') + '</div></div>' +",
  "'<div class=\"prop\"><div class=\"prop-l\">Vipāka</div><div class=\"prop-v\" data-no-i18n>' + afcEsc(r.vipaka ? t('vipaka|' + r.vipaka) : '—') + '</div></div>' +")
E("bits.push('suits the season');", "bits.push(t('suits the season'));")
E("if (n <= 0) return 'That is today\\u2019s free analyses \\u2014 three more tomorrow.';\n  return (n === 1 ? '1 free analysis' : n + ' free analyses') + ' left today';",
  "if (n <= 0) return t('That is today’s free analyses — three more tomorrow.');\n  return tn(n, '{n} free analysis left today', '{n} free analyses left today');")
E("const slotLabel = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', snack: 'something light' }[slot];",
  "const slotTitle = { breakfast: t('Best breakfast today'), lunch: t('Best lunch today'), dinner: t('Best dinner today'), snack: t('Best something light today') }[slot];")
E("'<div class=\"t-card-lbl\">Best ' + slotLabel + ' today</div>' +",
  "'<div class=\"t-card-lbl\">' + slotTitle + '</div>' +")
E("'<span class=\"t-avoid-chip\">' + b.meal.emoji + ' ' + afcEsc(b.meal.name) + ' · ' + b.score + '</span>'",
  "'<span class=\"t-avoid-chip\" data-no-i18n>' + b.meal.emoji + ' ' + afcEsc(b.meal.name) + ' · ' + b.score + '</span>'")
E("loadBits.push('your ' + d.name + ' constitution');",
  "loadBits.push(t('your {d} constitution', { d: d.name }));")
E("if (movedBy.length) loadBits.push('recent meals leaning ' + movedBy.map(x => DN[x]).join(' and ') + '-raising');\n  else if (Array.isArray(history) && history.some(h => (h.ts || 0) > Date.now() - 3 * 864e5)) loadBits.push('a steady few days in the journal');",
  "if (movedBy.length) loadBits.push(t('recent meals leaning {d}-raising', { d: movedBy.map(x => DN[x]).join(t(' and ')) }));\n  else if (Array.isArray(history) && history.some(h => (h.ts || 0) > Date.now() - 3 * 864e5)) loadBits.push(t('a steady few days in the journal'));")
E("'<div class=\"t-lead\">Here is how today sits for a ' + afcEsc(d.name) + ' constitution.</div>' +",
  "'<div class=\"t-lead\">' + afcEsc(t('Here is how today sits for a {d} constitution.', { d: d.name })) + '</div>' +")
E("'<div class=\"t-why\"><strong>Why?</strong> ' + afcEsc(loadBits.join(' · ')) + '.</div>' +",
  "'<div class=\"t-why\" data-no-i18n><strong>' + t('Why?') + '</strong> ' + afcEsc(loadBits.join(' · ')) + '.</div>' +")
E("why = early ? 'Classical practice pairs Kapha with a brisk, warming breath, done before eating.'\n                : 'Classical practice pairs Kapha with a steady, audible breath later in the day.';",
  "why = early ? window.t('Classical practice pairs Kapha with a brisk, warming breath, done before eating.')\n                : window.t('Classical practice pairs Kapha with a steady, audible breath later in the day.');")
E("why = 'Classical practice pairs Pitta with a soft, humming, unhurried breath.';",
  "why = window.t('Classical practice pairs Pitta with a soft, humming, unhurried breath.');")
E("why = 'Classical practice pairs Vāta with an even, alternating rhythm.';",
  "why = window.t('Classical practice pairs Vāta with an even, alternating rhythm.');")
E("const lead = p.raised ? 'For ' + DN[p.d] + ', which reads raised today. ' : '';",
  "const lead = p.raised ? t('For {d}, which reads raised today.', { d: DN[p.d] }) + ' ' : '';")
E("'<span class=\"t-breath-why\">' + afcEsc(lead + p.why) + '</span>' +",
  "'<span class=\"t-breath-why\" data-no-i18n>' + afcEsc(lead + p.why) + '</span>' +")
E("'<div class=\"t-breath-safe\">Practise seated, never while driving or standing in a headset. Stop if you feel dizzy or short of breath. ' +\n      (p.t === 'kapal' ? 'Skip Kapalabhati in pregnancy, with high blood pressure, heart disease, hernia or epilepsy, or after abdominal surgery. ' : '') +\n      'If you have a medical condition, ask your doctor first.</div>';",
  "'<div class=\"t-breath-safe\" data-no-i18n>' + afcEsc(t('Practise seated, never while driving or standing in a headset. Stop if you feel dizzy or short of breath.')) + ' ' +\n      (p.t === 'kapal' ? afcEsc(t('Skip Kapalabhati in pregnancy, with high blood pressure, heart disease, hernia or epilepsy, or after abdominal surgery.')) + ' ' : '') +\n      afcEsc(t('If you have a medical condition, ask your doctor first.')) + '</div>';")
E("'<span class=\"t-part-name\">' + afcEsc(r.name) + '</span>' +\n      '<span class=\"t-part-props\">' + afcEsc(r.virya || '') + ' · ' + afcEsc(r.rasa || '') + '</span>' +",
  "'<span class=\"t-part-name\">' + afcEsc(afcRowName(r)) + '</span>' +\n      '<span class=\"t-part-props\" data-no-i18n>' + afcEsc(tr(r.virya || '')) + ' · ' + afcEsc(afcTasteList(r.rasa)) + '</span>' +")
E("        question: question.slice(0, 400),\n        dosha: dosha,",
  "        question: question.slice(0, 400),\n        dosha: dosha,\n        lang: AFC_LANG,")
E("'<span class=\"t-pick-body\"><span class=\"t-pick-name\">' + afcEsc(p.name) + '</span>' +\n    (p.why ?",
  "'<span class=\"t-pick-body\"><span class=\"t-pick-name\">' + afcEsc(afcFoodName(p.slug, p.name)) + '</span>' +\n    (p.why ?")
E("'<div class=\"ask-meta\">Answered for your prakriti, this season and this hour, from the published food reference. ' +\n        'Traditional practice, not medical advice.' +\n        (typeof data.remaining === 'number' ? ' · ' + data.remaining + ' question' + (data.remaining === 1 ? '' : 's') + ' left today' : '') +",
  "'<div class=\"ask-meta\" data-no-i18n>' + afcEsc(t('Answered for your prakriti, this season and this hour, from the published food reference.')) + ' ' +\n        afcEsc(t('Traditional practice, not medical advice.')) +\n        (typeof data.remaining === 'number' ? ' · ' + afcEsc(tn(data.remaining, '{n} question left today', '{n} questions left today')) : '') +")
E("'<div class=\"ask-answer\">' + afcEsc(reason) + ' Here is what the on-device guide suggests for right now instead.</div>' +",
  "'<div class=\"ask-answer\" data-no-i18n>' + afcEsc(tr(reason)) + ' ' + afcEsc(t('Here is what the on-device guide suggests for right now instead.')) + '</div>' +")
E("fix: 'Replace ' + Math.min(3, cold.length) + ' cold breakfast' + (Math.min(3, cold.length) === 1 ? '' : 's') + ' next week with something warm and cooked.' });",
  "fix: tn(Math.min(3, cold.length), 'Replace {n} cold breakfast next week with something warm and cooked.', 'Replace {n} cold breakfasts next week with something warm and cooked.') });")
E("d: warmDinners.length + ' evening meal' + (warmDinners.length === 1 ? '' : 's') + ' scored well for your constitution.' });",
  "d: tn(warmDinners.length, '{n} evening meal scored well for your constitution.', '{n} evening meals scored well for your constitution.') });")
E("d: goodMornings.length + ' breakfast' + (goodMornings.length === 1 ? '' : 'es') + ' suited you well.' });",
  "d: tn(goodMornings.length, '{n} breakfast suited you well.', '{n} breakfasts suited you well.') });")
# Pattern titles/descriptions are whole literals; t() keeps them out of the DOM pass's way.
for s in ['Cold food in the morning', 'Heavy food late in the evening', 'A lot of sour taste', 'Raw and dry food',
          'Warm, well-judged dinners', 'Strong mornings']:
    E("t: '%s'" % s, "t: t('%s')" % s)
for s in ['Cooling food before midday sits against the classical pattern of warming a slow morning digestion.',
          'The evening is a Kapha window; a rich meal inside it is the most common single cause of a low weekly score.',
          'Sour is heating and, taken often, is the taste most likely to push a score down for your constitution.',
          'Dry, light, astringent food eaten cold is the classical Vāta-raising combination.']:
    E("d: '%s'" % s, "d: t('%s')" % s)
for s in ['Move your largest meal to the middle of the day next week.',
          'Swap sour for sweet or astringent in three meals next week.',
          'Cook three of next week’s raw meals and add a little ghee or oil.']:
    E("fix: '%s'" % s, "fix: t('%s')" % s)
E("'<div style=\"font-family:\\'Playfair Display\\',serif;font-size:18px;margin-bottom:8px;\">' + n + ' more meal' + (n === 1 ? '' : 's') + ' to go</div>' +",
  "'<div style=\"font-family:\\'Playfair Display\\',serif;font-size:18px;margin-bottom:8px;\">' + tn(n, '{n} more meal to go', '{n} more meals to go') + '</div>' +")
E("(delta >= 0 ? '↑ ' : '↓ ') + Math.abs(delta) + ' vs last week</span>';",
  "(delta >= 0 ? '↑ ' : '↓ ') + t('{n} vs last week', { n: Math.abs(delta) }) + '</span>';")
E("'<div class=\"t-card-lbl\">You analysed ' + thisW.length + ' meal' + (thisW.length === 1 ? '' : 's') + '</div>' +",
  "'<div class=\"t-card-lbl\">' + tn(thisW.length, 'You analysed {n} meal', 'You analysed {n} meals') + '</div>' +")
E("bands[b[0]] + ' ' + b[2] + '</div>').join('') +",
  "t('{n} ' + b[2], { n: bands[b[0]] }) + '</div>').join('') +")
E("try { showToast(left + ' free analys' + (left === 1 ? 'is' : 'es') + ' left today'); } catch (e) {}",
  "try { showToast(tn(left, '{n} free analysis left today', '{n} free analyses left today')); } catch (e) {}")
E("const whyHtml = why.length ? '<div class=\"why-lbl\">Why ' + (myScore >= 65 ? '' : 'only ') + myScore + '?</div>' +",
  "const whyHtml = why.length ? '<div class=\"why-lbl\">' + (myScore >= 65 ? t('Why {n}?', { n: myScore }) : t('Why only {n}?', { n: myScore })) + '</div>' +")
E("'<div class=\"res-name\">' + afcEsc(r.foodName || 'Food') + '</div>' +",
  "'<div class=\"res-name\">' + afcEsc((AFC_LANG === 'uk' && r.foodNameUk) || r.foodName || t('Food')) + '</div>' +")
E("'<div><div class=\"score-verd\" style=\"color:' + vs2.color + '\">' + verdict + (dosha && DOSHA[dosha] ? ' for ' + DOSHA[dosha].name : '') + '</div>' +",
  "'<div><div class=\"score-verd\" style=\"color:' + vs2.color + '\" data-no-i18n>' + (dosha && DOSHA[dosha] ? t('{v} for {d}', { v: tr(verdict), d: DOSHA[dosha].name }) : tr(verdict)) + '</div>' +")
E("'<div class=\"prop\"><div class=\"prop-l\">Rasa</div><div class=\"prop-v\">' + afcEsc(r.rasa || '—') + '</div></div>' +",
  "'<div class=\"prop\"><div class=\"prop-l\">Rasa</div><div class=\"prop-v\">' + afcEsc(r.rasa ? afcTasteList(r.rasa) : '—') + '</div></div>' +")
# Journal entries keep the English food name (it is what the reference is matched
# on); the Ukrainian label, when the server sent one, rides along for display.
E("food:r.foodName||'Food', emoji:r.emoji||'🍽️', category:r.category||'',",
  "food:(AFC_LANG === 'uk' && r.foodNameUk) || r.foodName || t('Food'), emoji:r.emoji||'🍽️', category:r.category||'',")
# Prakriti Program (namespaced block).
E("'<p class=\"lead\">Answer for how you have been most of your life, not just lately. Answer at least '+PP_MIN+' to see your program — the rest are optional and improve accuracy. <strong>'+answered+'/'+QUESTIONS.length+' answered.</strong></p>';",
  "'<p class=\"lead\">'+esc(t('Answer for how you have been most of your life, not just lately. Answer at least {m} to see your program — the rest are optional and improve accuracy.',{m:PP_MIN}))+' <strong>'+esc(t('{a}/{b} answered.',{a:answered,b:QUESTIONS.length}))+'</strong></p>';")
E("if(!done) html+='<p class=\"hint\">Answer '+remaining+' more to unlock your program ('+PP_MIN+' minimum).</p>';",
  "if(!done) html+='<p class=\"hint\">'+esc(t('Answer {r} more to unlock your program ({m} minimum).',{r:remaining,m:PP_MIN}))+'</p>';")
E("var label=r.dual?(meta.name+\"–\"+DOSHA_META[r.dual].name+\" Prakriti\"):(meta.name+\" Prakriti\");",
  "var label=t('{d} Prakriti',{d:r.dual?(tr(meta.name)+\"–\"+tr(DOSHA_META[r.dual].name)):tr(meta.name)});")
E("'<p class=\"lead\">A daily routine and meal rhythm to bring '+meta.name+' back into balance.</p>';",
  "'<p class=\"lead\">'+esc(t('A daily routine and meal rhythm to bring {d} back into balance.',{d:tr(meta.name)}))+'</p>';")
E("+'\">Week '+(i+1)+'</button>';", "+'\">'+t('Week {n}',{n:i+1})+'</button>';")
E("'<div class=\"card weeknote\"><span class=\"wt\">'+WEEKS[state.week].title+'.</span>",
  "'<div class=\"card weeknote\"><span class=\"wt\">'+tr(WEEKS[state.week].title)+'.</span>")
E("'<button class=\"dayhead\" data-day=\"'+d+'\"><span class=\"dayname\">Day '+(dayIndex+1)+",
  "'<button class=\"dayhead\" data-day=\"'+d+'\"><span class=\"dayname\">'+t('Day {n}',{n:dayIndex+1})+")

h.rep("// v5.2.2 · Breath for today", "// v5.2.2 · Breath for today")  # anchor sanity
open_out = {P('index.html'): h.src}

# ════════════════════════════════════════════════════════════════════════════
# sw.js — the dictionary has to be there offline as well
# ════════════════════════════════════════════════════════════════════════════
s = Patch(P('sw.js'))
s.rep("const CACHE = 'ayurfood-v4';", "const CACHE = 'ayurfood-v5';")
s.rep("  '/manifest.json',\n", "  '/manifest.json',\n  '/i18n/uk.js?v=5.3.0',\n")
open_out[P('sw.js')] = s.src
n = Patch(P('netlify.toml'))
n.rep('''[[redirects]]
  from = "/food/*"
  to = "https://ayurveda-content.netlify.app/food/:splat"
  status = 200
  force = true''', '''[[redirects]]
  from = "/food/*"
  to = "https://ayurveda-content.netlify.app/food/:splat"
  status = 200
  force = true

# v5.3.0 · Ukrainian food reference. The content site falls back to the English
# article (302 → /food/<slug>/) for anything not yet translated.
[[redirects]]
  from = "/uk/food/*"
  to = "https://ayurveda-content.netlify.app/uk/food/:splat"
  status = 200
  force = true''')
open_out[P('netlify.toml')] = n.src


# ════════════════════════════════════════════════════════════════════════════
# Ukrainian claim patterns, shared verbatim by analyse.js and guide.js
# ════════════════════════════════════════════════════════════════════════════
# JavaScript's \b only knows ASCII, so it cannot bound a Cyrillic word. These are
# stems with an explicit "no letter before" lookbehind and the u flag.
UK_PATTERNS = r'''
  // ── Ukrainian (v5.3.0). Stems, because Ukrainian inflects; JS \b is ASCII-only,
  // so the left edge is a Unicode-letter lookbehind instead.
  /(?<!\p{L})(виліков|лікує|лікуют|лікуван|лікувальн|зціл|ліки від|засіб від)/iu,
  /(?<!\p{L})(запобіга|профілакти|захища\p{L}*\s+від|знижу\p{L}*\s+ризик)/iu,
  /(?<!\p{L})(покращ|підвищ|зміцн|посил|підтриму|стимулю|нормалізу|прискор|сприя|допомага)\p{L}*\s+(\p{L}+\s+)?(імун|метабол|обмін\p{L}*\s+речовин|травлен|печінк|серц|мозк|мозок|пам[ʼ'’]?ят|енергі|схудн|сон|сну)/iu,
  /(?<!\p{L})(детокс|шлак|токсин|очищ\p{L}*\s+(організм|печінк|кров|кишк))/iu,
  /(?<!\p{L})(схудн|скинути\s+вагу|зниженн\p{L}*\s+ваги|спалю\p{L}*\s+жир|жироспал)/iu,
  /(?<!\p{L})(зниж|підвищ|регулю|нормалізу)\p{L}*\s+(рів\p{L}*\s+)?(цукр|тиск|холестерин|запален|глюкоз)/iu,
  /(?<!\p{L})(діабет|рак(?!\p{L})|раков|онколог|артрит|депресі|тривожн\p{L}*\s+розлад|гіпертоні|хвороб\p{L}*\s+крона|синдром\p{L}*\s+подразнен)/iu,
  /(?<!\p{L})(нетравлен|диспепс|здутт|метеоризм|закреп|рефлюкс|печі[яїю](?!\p{L})|нудот|безсонн|мігрен|головн\p{L}*\s+біл)/iu,
  /(?<!\p{L})(протизапальн|антиоксидант|імуностимул|лікарськ|терапевтичн|цілющ|оздоровч)/iu,
  /(?<!\p{L})(діагноз|діагност|дозуванн|дозу(?!\p{L})|призначенн\p{L}*\s+лікар)|\d\s*(мг|г|мл)(?!\p{L})/iu,
'''

UK_LANG_ANALYSE = r'''
    // v5.3.0 · Ukrainian. Enum fields stay English because the client keys on
    // them (tastes, virya, vipaka, verdict, effect); foodName stays English
    // because the food reference is matched on it. Everything a person reads
    // is written in Ukrainian, under the same legal rule.
    const lang = (body && body.lang === 'uk') ? 'uk' : 'en';
    const langRule = lang !== 'uk' ? '' : `

OUTPUT LANGUAGE — UKRAINIAN.
Write "category", "season", every "desc", "advice", every "why" and every "tips" entry in natural, correct Ukrainian (українська мова), addressed to the person as "ви". Add "foodNameUk": the dish's usual Ukrainian name.
Keep these EXACTLY in English, as specified: "foodName", "rasa", "virya", "vipaka", "tastes", "verdict", and "effect".
Sanskrit terms in Ukrainian prose: Вата, Пітта, Капха, доша, раса, вірʼя, віпака, агні.
The legal rule above applies to the Ukrainian text in full. Never write "покращує травлення", "зміцнює імунітет", "виводить токсини", "сприяє схудненню", "знижує запалення" or anything similar, and name no disease or symptom. Write "Аюрведа вважає імбир зігрівальним і вживає його перед їжею", never "імбир покращує травлення".`;'''

# ════════════════════════════════════════════════════════════════════════════
# analyse.js
# ════════════════════════════════════════════════════════════════════════════
a = Patch(P('netlify', 'functions', 'analyse.js'))
a.rep("  /\\b(diagnos\\w+|prescrib\\w+|dosage)\\b|\\d\\s*(mg|g|ml)\\b/i,\n];",
      "  /\\b(diagnos\\w+|prescrib\\w+|dosage)\\b|\\d\\s*(mg|g|ml)\\b/i," + UK_PATTERNS + "];")
a.rep("    const { foodName, imageB64, dosha } = JSON.parse(event.body || '{}');",
      "    const body = JSON.parse(event.body || '{}');\n    const { foodName, imageB64, dosha } = body;" + UK_LANG_ANALYSE)
a.rep('"improve":{"target":0-100,"tips":["string"]}}`;',
      '"improve":{"target":0-100,"tips":["string"]}}${lang === \'uk\' ? \' — plus "foodNameUk":"string"\' : \'\'}${langRule}`;')
a.rep("obj.advice = afcSafeText(obj.advice, 'Judge this one on its qualities above.', 'advice');",
      "obj.advice = afcSafeText(obj.advice, lang === 'uk' ? 'Оцініть цю страву за її якостями вище.' : 'Judge this one on its qualities above.', 'advice');\n"
      "      obj.category = afcSafeText(obj.category, '', 'category');\n"
      "      obj.season = afcSafeText(obj.season, '', 'season');\n"
      "      if (lang === 'uk') obj.foodNameUk = afcSafeText(String(obj.foodNameUk || '').slice(0, 80), '', 'foodNameUk');\n"
      "      else delete obj.foodNameUk;")
# Ukrainian runs ~20% longer than English for the same content.
a.rep(".map(w => String(w == null ? '' : w).trim().slice(0, 110))",
      ".map(w => String(w == null ? '' : w).trim().slice(0, lang === 'uk' ? 140 : 110))")
a.rep(".map(t => String(t == null ? '' : t).trim().slice(0, 90))",
      ".map(t => String(t == null ? '' : t).trim().slice(0, lang === 'uk' ? 115 : 90))")
a.rep("max_tokens: 1900,", "max_tokens: lang === 'uk' ? 2400 : 1900,")
open_out[a.path] = a.src

# ════════════════════════════════════════════════════════════════════════════
# guide.js
# ════════════════════════════════════════════════════════════════════════════
g = Patch(P('netlify', 'functions', 'guide.js'))
g.rep("  /\\b(diagnos\\w+|prescrib\\w+|dosage)\\b|\\d\\s*(mg|g|ml)\\b/i,\n];",
      "  /\\b(diagnos\\w+|prescrib\\w+|dosage)\\b|\\d\\s*(mg|g|ml)\\b/i," + UK_PATTERNS + "];")
g.rep("Give 2 to 4 picks and 0 to 3 avoids.`;\n}",
      "Give 2 to 4 picks and 0 to 3 avoids.${ctx.lang === 'uk' ? `\n\nOUTPUT LANGUAGE — UKRAINIAN\n"
      "Write \"answer\" and every \"why\" in natural, correct Ukrainian (українська мова), addressing the person as \"ви\". "
      "Keep \"slug\" exactly as in the library; \"name\" may stay as in the library (the app shows its own Ukrainian name). "
      "The person may write in Ukrainian or Russian — always answer in Ukrainian. "
      "Sanskrit terms: Вата, Пітта, Капха, доша, раса, вірʼя, віпака, агні. "
      "The legal rule applies to the Ukrainian text in full: never write \"покращує травлення\", \"зміцнює імунітет\", "
      "\"виводить токсини\", \"сприяє схудненню\" or similar, and name no disease or symptom.` : ''}`;\n}")
g.rep("why: String(p.why || '').slice(0, 90) };",
      "why: String(p.why || '').slice(0, 115) };")
g.rep("    const dosha    = body.dosha;", "    const dosha    = body.dosha;\n    const lang     = body.lang === 'uk' ? 'uk' : 'en';")
g.rep("      foods:  foodLines(rows),\n    });", "      foods:  foodLines(rows),\n      lang:   lang,\n    });")
g.rep("        'and no outcome.';",
      "        'and no outcome.' + (lang === 'uk' ? ' Answer in Ukrainian.' : '');")
g.rep("      out.answer = 'Here is what suits your constitution at this hour and in this season.';",
      "      out.answer = lang === 'uk'\n        ? 'Ось що пасує вашій конституції в цю годину і в цей сезон.'\n        : 'Here is what suits your constitution at this hour and in this season.';")
open_out[g.path] = g.src

# ── New files must be present before anything is written.
for f in [P('i18n', 'uk.js'), P('privacy-uk.html')]:
    if not os.path.exists(f):
        sys.exit('ABORT: %s is missing — upload it with this patch' % os.path.relpath(f, ROOT))

for path, src in open_out.items():
    with io.open(path, 'w', encoding='utf-8', newline='') as f: f.write(src)
    print('patched', os.path.relpath(path, ROOT))
print('v5.3.0 applied.')
