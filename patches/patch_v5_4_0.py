#!/usr/bin/env python3
"""
patch_v5_4_0.py — local weather in every recommendation (v5.3.0 → v5.4.0)

Run from the repository root, AFTER patch_v5_3_0.py:

    python3 patches/patch_v5_4_0.py

What it adds
  · A fifth input to the doṣa engine: the weather where the person is now.
    Cold/dry/windy reads as Vāta, hot/bright as Pitta, cold/damp/grey as Kapha
    (classical ṛtucaryā logic). The calendar season stays as the fallback and
    keeps a smaller weight when real weather is known.
  · TODAY shows the weather line and its doṣa; "Why?" names it.
  · GUIDE: the three-tap picks use it on the device; a typed question sends the
    weather numbers (never a location) to guide.js, which tells the model.
  · Prakriti Program: each of the next 7 days gets that day's forecast and a
    weather-adjusted menu — a note per meal and a weather-matched snack.

Location never leaves Netlify: netlify/functions/weather.mjs (new, ship with
this patch) reads Netlify's own IP-based city, rounds it, asks MET Norway, and
returns weather plus the city name only. No browser permission prompt.

Touches: Ayurfood/index.html, Ayurfood/netlify/functions/guide.js,
         Ayurfood/sw.js (cache bump), Ayurfood/i18n/uk.js (new strings),
         Ayurfood/privacy.html, Ayurfood/privacy-uk.html (weather paragraph)
New file: Ayurfood/netlify/functions/weather.mjs
"""
import io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = lambda *a: os.path.join(ROOT, 'Ayurfood', *a)

class Patch:
    def __init__(self, path):
        self.path = path
        with io.open(path, encoding='utf-8') as f: self.src = f.read()
    def rep(self, old, new, count=1):
        n = self.src.count(old)
        if n != count:
            sys.exit('ABORT %s: expected %d × %r, found %d' % (os.path.basename(self.path), count, old[:90], n))
        self.src = self.src.replace(old, new)

out = {}

# ════════════════════════════════════════════════════════════════════════════
# index.html
# ════════════════════════════════════════════════════════════════════════════
h = Patch(P('index.html'))
if 'v5.3.0' not in h.src or 'afcWx' in h.src:
    sys.exit('ABORT index.html: expected v5.3.0 (run patch_v5_3_0.py first), or already patched')
h.rep('margin-top:8px;">v5.3.0</p>', 'margin-top:8px;">v5.4.0</p>')
h.rep('AyurFood v5.3.0 ·', 'AyurFood v5.4.0 ·')
h.rep("/i18n/uk.js?v=5.3.0", "/i18n/uk.js?v=5.4.0")

# ── 1. The weather module, right after the season ─────────────────────────────
WX = r'''const AFC_SEASON_NAME = { vata: 'Vāta season — cool, dry, windy', pitta: 'Pitta season — hot and sharp', kapha: 'Kapha season — damp and heavy' };

// ── Weather (v5.4.0) ─────────────────────────────────────────────────────
// The fifth input. Ṛtucaryā reads the season from its qualities — cold, dry,
// windy is Vāta; hot and bright is Pitta; cold, damp and grey is Kapha — and the
// weather outside today is the same reading, made locally and for this week
// instead of from the calendar. The calendar season stays as the fallback.
//
// Location never touches the browser: /.netlify/functions/weather derives a
// city from Netlify's own IP geolocation, asks MET Norway, and returns weather
// plus the city name. Nothing here asks for permission or stores a position.
const AFC_WX_KEY = 'afc_wx_v1';
const AFC_WX_TTL = 90 * 60 * 1000;
let afcWx = null;
let afcWxLoading = null;

const afcClamp = (x) => Math.max(0, Math.min(1, x));

/** Weather point → how strongly it raises each doṣa, 0…1. */
function afcWxPress(w) {
  if (!w || typeof w.t !== 'number') return null;
  const t = w.t, rh = typeof w.rh === 'number' ? w.rh : 65, wind = w.wind || 0;
  const cloud = typeof w.cloud === 'number' ? w.cloud / 100 : 0.5;
  const wet = Math.max(w.precip >= 0.2 ? Math.min(1, 0.5 + w.precip / 4) : 0, w.wet || 0, /rain|snow|sleet|fog/.test(w.symbol || '') ? 0.6 : 0);
  const cold = afcClamp((14 - t) / 16), hot = afcClamp((t - 22) / 12);
  const dry = afcClamp((60 - rh) / 35), damp = Math.max(afcClamp((rh - 72) / 23), wet);
  const windy = afcClamp((wind - 12) / 28);
  return {
    vata:  afcClamp(0.45 * cold + 0.35 * windy + 0.3 * dry * (t < 22 ? 1 : 0.4)),
    pitta: afcClamp(0.75 * hot + 0.25 * (1 - cloud) * afcClamp((t - 16) / 10)),
    kapha: afcClamp(0.4 * cold * (0.4 + 0.6 * Math.max(damp, cloud)) + 0.45 * damp + 0.15 * cloud * (t < 20 ? 1 : 0)),
  };
}
/** The doṣa the weather raises, when it clearly raises one. */
function afcWxTop(p) {
  if (!p) return null;
  const r = DOSHA_ORDER.slice().sort((a, b) => p[b] - p[a]);
  return p[r[0]] >= 0.35 ? r[0] : null;
}
/** "+3°C, cloudy, damp" — words, not numbers, after the temperature. */
function afcWxDesc(w) {
  if (!w || typeof w.t !== 'number') return '';
  const bits = [(w.t > 0 ? '+' : '') + Math.round(w.t) + '°C'];
  const s = w.symbol || '';
  if (/snow|sleet/.test(s)) bits.push(t('snow'));
  else if (w.precip >= 0.2 || (w.wet || 0) >= 0.3 || /rain/.test(s)) bits.push(t('rain'));
  else if (/fog/.test(s)) bits.push(t('fog'));
  else if (typeof w.cloud === 'number' && w.cloud >= 70) bits.push(t('cloudy'));
  else if (typeof w.cloud === 'number' && w.cloud <= 25) bits.push(t('clear'));
  if ((w.wind || 0) >= 25) bits.push(t('windy'));
  if (typeof w.rh === 'number' && w.rh >= 82 && bits.length < 3) bits.push(t('damp'));
  else if (typeof w.rh === 'number' && w.rh <= 40) bits.push(t('dry'));
  return bits.join(', ');
}
function afcLocalDate(dt) {
  const d = dt || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
/** Pressure from the weather now, or null when weather is unknown. */
function afcWxNow() { return afcWx && afcWx.current ? afcWxPress(afcWx.current) : null; }
/** A forecast day for a local date, or null beyond the 7-day outlook. */
function afcWxDay(date) {
  if (!afcWx || !Array.isArray(afcWx.days)) return null;
  return afcWx.days.find(x => x.date === afcLocalDate(date)) || null;
}

/** Fetch once per 90 minutes; every view re-renders when it arrives. */
function afcLoadWeather() {
  if (afcWxLoading) return afcWxLoading;
  try {
    const c = JSON.parse(localStorage.getItem(AFC_WX_KEY) || 'null');
    if (c && c.v && Date.now() - c.t < AFC_WX_TTL) { afcWx = c.v; return Promise.resolve(afcWx); }
    if (c && c.v && Date.now() - c.t < 12 * 3600 * 1000) afcWx = c.v;   // stale but better than nothing offline
  } catch (e) {}
  let tz = 'UTC';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) {}
  afcWxLoading = fetch('/.netlify/functions/weather?tz=' + encodeURIComponent(tz), { signal: AbortSignal.timeout ? AbortSignal.timeout(7000) : undefined })
    .then(r => r.ok ? r.json() : null)
    .then(j => {
      if (j && j.wx && j.wx.current) {
        afcWx = j.wx;
        try { localStorage.setItem(AFC_WX_KEY, JSON.stringify({ t: Date.now(), v: afcWx })); } catch (e) {}
        afcWxRefreshViews();
      }
      return afcWx;
    })
    .catch(() => afcWx)
    .finally(() => { setTimeout(() => { afcWxLoading = null; }, AFC_WX_TTL); });
  return afcWxLoading;
}
function afcWxRefreshViews() {
  try {
    const vis = id => { const el = document.getElementById(id); return el && el.offsetParent !== null; };
    if (vis('today-body')) renderToday();
    if (vis('guide-body') && typeof renderGuide === 'function') renderGuide();
    if (vis('pp-app') && window.PP && PP.refresh) PP.refresh();
  } catch (e) {}
}
/** The card line on TODAY. */
function afcWxLine() {
  if (!afcWx || !afcWx.current) return '';
  const top = afcWxTop(afcWxNow());
  const place = afcWx.place && afcWx.place.city ? afcEsc(afcWx.place.city) : t('Where you are');
  return '<div class="t-wx">' +
    '<span class="t-wx-main">🌦 ' + place + ' · ' + afcEsc(afcWxDesc(afcWx.current)) +
      (top ? ' → <strong style="color:' + DC[top] + ';">' + afcEsc(t('{d} rises', { d: DN[top] })) + '</strong>' : '') + '</span>' +
    '<a class="t-wx-src" href="https://www.met.no/en" target="_blank" rel="noopener">' + afcEsc(t('Weather: MET Norway')) + '</a>' +
  '</div>';
}
/** What guide.js receives: numbers and a doṣa key — never a place. */
function afcWxForGuide() {
  if (!afcWx || !afcWx.current) return null;
  const c = afcWx.current;
  return { t: c.t, rh: c.rh, wind: c.wind, cloud: c.cloud, precip: c.precip, symbol: c.symbol, raises: afcWxTop(afcWxNow()) };
}'''
h.rep("const AFC_SEASON_NAME = { vata: 'Vāta season — cool, dry, windy', pitta: 'Pitta season — hot and sharp', kapha: 'Kapha season — damp and heavy' };", WX)

# ── 2. The engine: balance and score read the weather ─────────────────────────
h.rep("""//   4. recent meals  — what the journal recorded over the last three days""",
      """//   4. recent meals  — what the journal recorded over the last three days
//   5. weather       — today's weather where the person is (v5.4.0); when it
//                      is known it carries most of the season's weight""")
h.rep("""  const season = afcSeason();
  const mine = primaryDoshas(dosha);
  const out = {};
  DOSHA_ORDER.forEach(d => {
    let v = 0;
    if (mine.indexOf(d) !== -1) v += 0.45;            // your own doṣa runs closer to its edge
    if (season === d) v += 0.45;                       // the season raises it for everyone""",
"""  const season = afcSeason();
  const wx = afcWxNow();
  const mine = primaryDoshas(dosha);
  const out = {};
  DOSHA_ORDER.forEach(d => {
    let v = 0;
    if (mine.indexOf(d) !== -1) v += 0.45;            // your own doṣa runs closer to its edge
    if (season === d) v += wx ? 0.2 : 0.45;            // the season raises it for everyone…
    if (wx) v += wx[d] * 0.8;                          // …and today's weather says by how much""")
h.rep("""    values: out, load, season, top: rank[0],""", """    values: out, load, season, wx, top: rank[0],""")
h.rep("""  const season = opt.season || afcSeason();
  s -= (eff[season] || 0) * 5;""",
"""  const season = opt.season || afcSeason();
  const wx = opt.wx !== undefined ? opt.wx : afcWxNow();
  s -= (eff[season] || 0) * (wx ? 2.5 : 5);
  if (wx) DOSHA_ORDER.forEach(d => { s -= (eff[d] || 0) * wx[d] * 6; });""")
h.rep("const ctx    = { season: afcSeason(), kala: afcKalaDosha(), load: afcRecentLoad(), bias: opt.bias };",
      "const ctx    = { season: afcSeason(), kala: afcKalaDosha(), load: afcRecentLoad(), bias: opt.bias, wx: afcWxNow() };")
h.rep("""  const season = item.ctx ? item.ctx.season : afcSeason();
  if (!mine.length && item.eff[season] <= -0.35) bits.push(t('suits the season'));""",
"""  const season = item.ctx ? item.ctx.season : afcSeason();
  const wxTop = afcWxTop(item.ctx ? item.ctx.wx : afcWxNow());
  if (wxTop && item.eff[wxTop] <= -0.35 && bits.length < 3) bits.push(t('suits today’s weather'));
  else if (!mine.length && item.eff[season] <= -0.35) bits.push(t('suits the season'));""")

# ── 3. TODAY ─────────────────────────────────────────────────────────────────
h.rep("""  const el = document.getElementById('today-body');
  if (!el) return;
  await afcLoadFoodRows();""",
"""  const el = document.getElementById('today-body');
  if (!el) return;
  afcLoadWeather();          // re-renders TODAY when it lands; never blocks it
  await afcLoadFoodRows();""")
h.rep("""  const loadBits = [];
  loadBits.push(AFC_SEASON_NAME[bal.season]);""",
"""  const loadBits = [];
  const wxTop = afcWxTop(bal.wx);
  if (afcWx && afcWx.current) {
    loadBits.push(wxTop ? t('today’s weather raises {d}', { d: DN[wxTop] }) : t('mild weather today'));
  } else {
    loadBits.push(AFC_SEASON_NAME[bal.season]);
  }""")
h.rep("""    '<div class="card t-balance">' +
      '<div class="t-card-lbl">Your balance today</div>' + balRows +
    '</div>' +""",
"""    '<div class="card t-balance">' +
      '<div class="t-card-lbl">Your balance today</div>' + balRows +
      afcWxLine() +
    '</div>' +""")
# Styles for the weather line.
h.rep("</style>", """  /* v5.4.0 · weather line */
  .t-wx{margin-top:12px;padding-top:10px;border-top:1px solid rgba(0,0,0,.06);display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline;justify-content:space-between;font-size:12.5px;color:#5C4E3D;}
  .t-wx-main{line-height:1.5;}
  .t-wx-src{font-size:10.5px;color:#9A8B78;text-decoration:none;}
  .pp-wx{font-size:12px;color:#5C4E3D;background:rgba(201,138,54,.08);border-radius:10px;padding:8px 10px;margin:8px 0 4px;line-height:1.5;}
  .pp-adj{display:block;font-size:11.5px;color:#8A6A3A;margin-top:3px;}
  .pp-was{display:block;font-size:11px;color:#9A8B78;text-decoration:line-through;margin-top:2px;}
  .daydate .pp-wxchip{margin-left:8px;font-size:11px;opacity:.85;}
</style>""", 1)

# ── 4. GUIDE: three-tap picks already use the engine; the typed question gets the weather.
h.rep("""        southern: afcSouthern(),
        recent: afcRecentForGuide(),""",
"""        southern: afcSouthern(),
        recent: afcRecentForGuide(),
        weather: afcWxForGuide(),""")
h.rep("""async function renderGuide() {""", """async function renderGuide() {
  afcLoadWeather();""", 1)

# ── 5. Prakriti Program: a weather-adjusted menu for each forecast day ────────
PP_WX = r'''var DOSHA_META = '''
PP_TABLE = r'''// v5.4.0 · Weather adjustments for the program's menu. Rows are the weather's
// doṣa, columns the person's dominant doṣa. Every line is classical practice —
// temperature, preparation, spice, portion — and never an effect on the body.
var WX_ADJ = {
  VATA: {
    VATA:  { note:"Cold, dry or windy weather doubles your own Vāta tendency — make every meal warm, moist and unhurried.",
             breakfast:"serve it hot, with an extra spoon of ghee", lunch:"add a cup of warm broth alongside", dinner:"make it a soup or stew; nothing raw", snacks:"Warm spiced milk with soaked dates" },
    PITTA: { note:"Cold, dry or windy weather asks for warmth even from a Pitta constitution — warm food, gentle spices.",
             breakfast:"eat it warm rather than chilled", lunch:"cook the vegetables instead of serving them raw", dinner:"add a little ghee; keep the spices mild", snacks:"Stewed pear with cardamom, served warm" },
    KAPHA: { note:"Cold, dry or windy weather — keep your meals warm and light, with a little more oil than usual.",
             breakfast:"serve it hot, with ginger", lunch:"add a teaspoon of ghee or sesame oil", dinner:"choose a warm soup over anything cold", snacks:"Ginger tea with a few soaked almonds" }
  },
  PITTA: {
    VATA:  { note:"Hot weather — cool things down without making them cold or dry.",
             breakfast:"let it cool to room temperature", lunch:"add cucumber, coriander or fresh mint", dinner:"keep it moist and mildly spiced", snacks:"Sweet ripe fruit at room temperature" },
    PITTA: { note:"Hot, bright weather doubles your own Pitta tendency — cooling, sweet and bitter at every meal.",
             breakfast:"serve it at room temperature, never hot", lunch:"add coriander, cucumber and bitter greens", dinner:"leave out chilli, garlic, vinegar and sour", snacks:"Fresh coconut water or sweet melon" },
    KAPHA: { note:"Hot weather — lighter and cooler, but still lightly spiced.",
             breakfast:"keep it light and not too sweet", lunch:"add bitter greens and fresh herbs", dinner:"eat early and light", snacks:"Cucumber slices with mint" }
  },
  KAPHA: {
    VATA:  { note:"Cold, damp, grey weather — warm and well spiced, but not heavy.",
             breakfast:"serve it hot, with ginger and cinnamon", lunch:"add black pepper and a little more ginger", dinner:"keep the portion modest and the meal hot", snacks:"Ginger–lemon water, warm" },
    PITTA: { note:"Cold, damp, grey weather — lighter and warmer than usual, with mild pungent spices.",
             breakfast:"choose the lighter version and serve it warm", lunch:"add ginger and a pinch of black pepper", dinner:"keep it light; skip heavy dairy", snacks:"A few roasted pumpkin seeds" },
    KAPHA: { note:"Cold, damp, grey weather doubles your own Kapha tendency — light, warm, dry and pungent at every meal.",
             breakfast:"a small portion, hot, with ginger", lunch:"add black pepper, ginger and turmeric", dinner:"make it the lightest meal of the day; no dairy", snacks:"Hot ginger tea; nothing sweet" }
  }
};
var WX_KEY = { vata:'VATA', pitta:'PITTA', kapha:'KAPHA' };

var DOSHA_META = '''
h.rep(PP_WX, PP_TABLE, 1)

h.rep("""      var routine=ROUTINE[r.dominant];
      var meals=MEALS[r.dominant][dayIndex%MEALS[r.dominant].length];
      html+='<div class="daybody"><div class="daydiv"></div>'+
        '<div class="subhead" style="color:'+meta.color+'">Daily routine</div>';""",
"""      var routine=ROUTINE[r.dominant];
      var meals=MEALS[r.dominant][dayIndex%MEALS[r.dominant].length];
      // v5.4.0 · the forecast for this date, when it falls inside the 7-day outlook
      var wday=(typeof afcWxDay==='function')?afcWxDay(date):null;
      var wtop=wday?afcWxTop(afcWxPress(wday)):null;
      var adj=wtop?WX_ADJ[WX_KEY[wtop]][r.dominant]:null;
      html+='<div class="daybody"><div class="daydiv"></div>'+
        (wday?'<div class="pp-wx">🌦 '+esc(afcWxDesc(wday))+(wday.tmin!=null&&wday.tmax!=null?' ('+Math.round(wday.tmin)+'…'+Math.round(wday.tmax)+'°C)':'')+
          (adj?' → <strong>'+esc(t('{d} rises',{d:DN[wtop]}))+'</strong><br>'+esc(tr(adj.note)):'<br>'+esc(t('Mild weather — the menu stays as planned.')))+'</div>':'')+
        '<div class="subhead" style="color:'+meta.color+'">Daily routine</div>';""")
h.rep("""        '<div class="row"><span class="rk">Breakfast</span><span class="rv">'+meals.breakfast+'</span></div>'+
        '<div class="row"><span class="rk">Lunch</span><span class="rv">'+meals.lunch+'</span></div>'+
        '<div class="row"><span class="rk">Dinner</span><span class="rv">'+meals.dinner+'</span></div>'+
        '<div class="row"><span class="rk">Snacks</span><span class="rv">'+meals.snacks+'</span></div></div>';""",
"""        ppMealRow('Breakfast',meals.breakfast,adj&&adj.breakfast)+
        ppMealRow('Lunch',meals.lunch,adj&&adj.lunch)+
        ppMealRow('Dinner',meals.dinner,adj&&adj.dinner)+
        (adj
          ? '<div class="row"><span class="rk">Snacks</span><span class="rv" data-no-i18n>'+esc(tr(adj.snacks))+
              '<span class="pp-adj">'+esc(t('chosen for today’s weather'))+'</span><span class="pp-was">'+esc(tr(meals.snacks))+'</span></span></div>'
          : '<div class="row"><span class="rk">Snacks</span><span class="rv">'+meals.snacks+'</span></div>')+
        '</div>';""")
h.rep("""function bar(label,val,col){""",
"""function ppMealRow(label,meal,adj){
  if(!adj) return '<div class="row"><span class="rk">'+label+'</span><span class="rv">'+meal+'</span></div>';
  return '<div class="row"><span class="rk">'+label+'</span><span class="rv" data-no-i18n>'+esc(tr(meal))+
    '<span class="pp-adj">☁ '+esc(tr(adj))+'</span></span></div>';
}
function bar(label,val,col){""")
# Weather chip in each forecast day's header, and a refresh hook.
h.rep("""      '<span class="daydate">'+fmtDate(date)+'</span></span><span class="plus'+(open?" open":"")+'">+</span></button>';""",
"""      '<span class="daydate">'+fmtDate(date)+ppWxChip(date)+'</span></span><span class="plus'+(open?" open":"")+'">+</span></button>';""")
h.rep("""function ppMealRow(label,meal,adj){""",
"""function ppWxChip(date){
  if(typeof afcWxDay!=='function') return '';
  var w=afcWxDay(date); if(!w||typeof w.t!=='number') return '';
  return '<span class="pp-wxchip">'+(w.t>0?'+':'')+Math.round(w.t)+'°</span>';
}
function ppMealRow(label,meal,adj){""")
h.rep("""  function openProgram(){
    // (Re)mount fresh each open unless a result already exists this session
    if(!state.result){ state.view="quiz"; state.answers={}; }
    render();
  }""",
"""  function openProgram(){
    // (Re)mount fresh each open unless a result already exists this session
    if(!state.result){ state.view="quiz"; state.answers={}; }
    if(typeof afcLoadWeather==='function') afcLoadWeather();
    render();
  }""")
h.rep("""  return { open: openProgram, reset: resetProgram };""",
      """  return { open: openProgram, reset: resetProgram, refresh: function(){ if(state.view==="results") render(); } };""")
out[h.path] = h.src

# ════════════════════════════════════════════════════════════════════════════
# guide.js — the weather, as numbers, into the prompt
# ════════════════════════════════════════════════════════════════════════════
g = Patch(P('netlify', 'functions', 'guide.js'))
g.rep("""Time where they are: ${ctx.kala} (local hour ${ctx.hour})""",
"""Time where they are: ${ctx.kala} (local hour ${ctx.hour})
${ctx.weather ? 'Weather where they are right now: ' + ctx.weather + '\\nLet it shape the answer as ṛtucaryā does — warmth and moisture against cold and wind, cooling against heat, lightness and pungency against cold damp — and say so when it is the reason for a pick.' : ''}""")
g.rep("""    const recent = (Array.isArray(body.recent) ? body.recent : [])""",
"""    // v5.4.0 · weather arrives as numbers and a doṣa key, never as text, so
    // nothing the client sends can steer the prompt.
    const weather = (function (w) {
      if (!w || typeof w !== 'object') return '';
      const num = (x, lo, hi) => (Number.isFinite(Number(x)) ? Math.min(hi, Math.max(lo, Math.round(Number(x)))) : null);
      const t = num(w.t, -60, 60), rh = num(w.rh, 0, 100), wind = num(w.wind, 0, 250), cloud = num(w.cloud, 0, 100);
      const precip = Number.isFinite(Number(w.precip)) ? Math.min(50, Math.max(0, Number(w.precip))) : 0;
      if (t === null) return '';
      const sym = String(w.symbol || '').toLowerCase().replace(/[^a-z_]/g, '').slice(0, 40);
      const parts = [t + '°C'];
      if (rh !== null) parts.push('humidity ' + rh + '%');
      if (wind !== null) parts.push('wind ' + wind + ' km/h');
      if (cloud !== null) parts.push('cloud ' + cloud + '%');
      if (precip >= 0.2 || /rain|snow|sleet/.test(sym)) parts.push(/snow|sleet/.test(sym) ? 'snow' : 'rain');
      const raises = ['vata', 'pitta', 'kapha'].indexOf(w.raises) !== -1
        ? ' — the app reads this as raising ' + { vata: 'Vāta', pitta: 'Pitta', kapha: 'Kapha' }[w.raises] : '';
      return parts.join(', ') + raises + '.';
    })(body.weather);

    const recent = (Array.isArray(body.recent) ? body.recent : [])""")
g.rep("""      recent: recent,
      foods:  foodLines(rows),""", """      recent: recent,
      weather: weather,
      foods:  foodLines(rows),""")
out[g.path] = g.src

# ════════════════════════════════════════════════════════════════════════════
# sw.js — new cache so the v5.4.0 shell replaces v5.3.0 at once
# ════════════════════════════════════════════════════════════════════════════
s = Patch(P('sw.js'))
s.rep("const CACHE = 'ayurfood-v5';", "const CACHE = 'ayurfood-v6';")
s.rep("'/i18n/uk.js?v=5.3.0'", "'/i18n/uk.js?v=5.4.0'")
out[s.path] = s.src

# ════════════════════════════════════════════════════════════════════════════
# uk.js — the new strings
# ════════════════════════════════════════════════════════════════════════════
u = Patch(P('i18n', 'uk.js'))
UK_NEW = r'''
// ── v5.4.0 · weather ───────────────────────────────────────────────────
"snow": "сніг", "rain": "дощ", "fog": "туман", "cloudy": "хмарно", "clear": "ясно", "windy": "вітряно", "damp": "вогко", "dry": "сухо",
"Where you are": "Там, де ви",
"{d} rises": "{d} зростає",
"Weather: MET Norway": "Погода: MET Norway",
"suits today’s weather": "пасує сьогоднішній погоді",
"today’s weather raises {d}": "сьогоднішня погода підсилює дошу {d}",
"mild weather today": "сьогодні мʼяка погода",
"Mild weather — the menu stays as planned.": "Мʼяка погода — меню без змін.",
"chosen for today’s weather": "обрано за сьогоднішньою погодою",
"Cold, dry or windy weather doubles your own Vāta tendency — make every meal warm, moist and unhurried.": "Холодна, суха чи вітряна погода подвоює вашу схильність до Вати — нехай кожна трапеза буде теплою, вологою й неквапною.",
"serve it hot, with an extra spoon of ghee": "подавайте гарячим, з додатковою ложкою ґхі",
"add a cup of warm broth alongside": "додайте чашку теплого бульйону",
"make it a soup or stew; nothing raw": "зробіть суп чи рагу; нічого сирого",
"Warm spiced milk with soaked dates": "Тепле молоко зі спеціями й замоченими фініками",
"Cold, dry or windy weather asks for warmth even from a Pitta constitution — warm food, gentle spices.": "Холодна, суха чи вітряна погода вимагає тепла навіть від конституції Пітта — тепла їжа, мʼякі спеції.",
"eat it warm rather than chilled": "їжте теплим, а не охолодженим",
"cook the vegetables instead of serving them raw": "приготуйте овочі, а не подавайте сирими",
"add a little ghee; keep the spices mild": "додайте трохи ґхі; спеції — мʼякі",
"Stewed pear with cardamom, served warm": "Тушкована груша з кардамоном, тепла",
"Cold, dry or windy weather — keep your meals warm and light, with a little more oil than usual.": "Холодна, суха чи вітряна погода — тримайте страви теплими й легкими, з трохи більшою кількістю олії, ніж зазвичай.",
"serve it hot, with ginger": "подавайте гарячим, з імбиром",
"add a teaspoon of ghee or sesame oil": "додайте чайну ложку ґхі чи кунжутної олії",
"choose a warm soup over anything cold": "оберіть теплий суп замість будь-чого холодного",
"Ginger tea with a few soaked almonds": "Імбирний чай і трохи замоченого мигдалю",
"Hot weather — cool things down without making them cold or dry.": "Спекотна погода — охолоджуйте страви, але не робіть їх холодними чи сухими.",
"let it cool to room temperature": "дайте охолонути до кімнатної температури",
"add cucumber, coriander or fresh mint": "додайте огірок, коріандр чи свіжу мʼяту",
"keep it moist and mildly spiced": "нехай буде соковитим і злегка приправленим",
"Sweet ripe fruit at room temperature": "Солодкі стиглі фрукти кімнатної температури",
"Hot, bright weather doubles your own Pitta tendency — cooling, sweet and bitter at every meal.": "Спекотна, сонячна погода подвоює вашу схильність до Пітти — охолоджувальне, солодке й гірке в кожній трапезі.",
"serve it at room temperature, never hot": "подавайте кімнатної температури, не гарячим",
"add coriander, cucumber and bitter greens": "додайте коріандр, огірок і гірку зелень",
"leave out chilli, garlic, vinegar and sour": "приберіть чилі, часник, оцет і кисле",
"Fresh coconut water or sweet melon": "Свіжа кокосова вода чи солодка диня",
"Hot weather — lighter and cooler, but still lightly spiced.": "Спекотна погода — легше й прохолодніше, але все ж злегка приправлене.",
"keep it light and not too sweet": "нехай буде легким і не надто солодким",
"add bitter greens and fresh herbs": "додайте гірку зелень і свіжі трави",
"eat early and light": "вечеряйте рано й легко",
"Cucumber slices with mint": "Скибочки огірка з мʼятою",
"Cold, damp, grey weather — warm and well spiced, but not heavy.": "Холодна, вогка, похмура погода — тепле й добре приправлене, але не важке.",
"serve it hot, with ginger and cinnamon": "подавайте гарячим, з імбиром і корицею",
"add black pepper and a little more ginger": "додайте чорний перець і трохи більше імбиру",
"keep the portion modest and the meal hot": "помірна порція, гаряча страва",
"Ginger–lemon water, warm": "Тепла вода з імбиром і лимоном",
"Cold, damp, grey weather — lighter and warmer than usual, with mild pungent spices.": "Холодна, вогка, похмура погода — легше й тепліше, ніж зазвичай, з мʼякими пекучими спеціями.",
"choose the lighter version and serve it warm": "оберіть легший варіант і подавайте теплим",
"add ginger and a pinch of black pepper": "додайте імбир і дрібку чорного перцю",
"keep it light; skip heavy dairy": "легко; без важких молочних продуктів",
"A few roasted pumpkin seeds": "Трохи підсмаженого гарбузового насіння",
"Cold, damp, grey weather doubles your own Kapha tendency — light, warm, dry and pungent at every meal.": "Холодна, вогка, похмура погода подвоює вашу схильність до Капхи — легке, тепле, сухе й пекуче в кожній трапезі.",
"a small portion, hot, with ginger": "невелика порція, гаряча, з імбиром",
"add black pepper, ginger and turmeric": "додайте чорний перець, імбир і куркуму",
"make it the lightest meal of the day; no dairy": "найлегша трапеза дня; без молочного",
"Hot ginger tea; nothing sweet": "Гарячий імбирний чай; нічого солодкого",
'''
u.rep('''"API key saved ✓": "Ключ збережено ✓"
};''', '''"API key saved ✓": "Ключ збережено ✓",''' + UK_NEW + '''"__end": ""
};''')
out[u.path] = u.src

# ════════════════════════════════════════════════════════════════════════════
# Privacy — the weather paragraph, both languages
# ════════════════════════════════════════════════════════════════════════════
pe = Patch(P('privacy.html'))
pe.rep("""    <h2>6. Data Storage and Security</h2>""", """    <h3>Weather</h3>
    <p>To adjust recommendations to the weather where you are, our hosting provider (Netlify) estimates an approximate city-level location from your IP address when the app asks for weather. The coordinates are rounded to about 10&nbsp;km and used only to request a forecast from MET Norway; they are not stored, not logged by us, and not sent to your browser or to our AI provider. The app receives only the city name and the weather. Weather data: MET Norway, licensed under CC BY 4.0.</p>

    <h2>6. Data Storage and Security</h2>""")
out[pe.path] = pe.src

pu = Patch(P('privacy-uk.html'))
pu.rep("""  <h2>6. Зберігання та безпека даних</h2>""", """  <h3>Погода</h3>
  <p>Щоб підлаштовувати рекомендації під погоду там, де ви перебуваєте, наш хостинг-провайдер (Netlify) визначає приблизне місцеположення на рівні міста за вашою IP-адресою, коли застосунок запитує погоду. Координати округлюються приблизно до 10&nbsp;км і використовуються лише для запиту прогнозу в MET Norway; вони не зберігаються, ми їх не записуємо в журнали й не передаємо ні у ваш браузер, ні нашому постачальнику ШІ. Застосунок отримує лише назву міста й погоду. Дані про погоду: MET Norway, ліцензія CC BY 4.0.</p>

  <h2>6. Зберігання та безпека даних</h2>""")
out[pu.path] = pu.src

if not os.path.exists(P('netlify', 'functions', 'weather.mjs')):
    sys.exit('ABORT: Ayurfood/netlify/functions/weather.mjs is missing — upload it with this patch')

for path, src in out.items():
    with io.open(path, 'w', encoding='utf-8', newline='') as f: f.write(src)
    print('patched', os.path.relpath(path, ROOT))
print('v5.4.0 applied.')
