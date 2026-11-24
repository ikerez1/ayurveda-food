// weather.mjs — today's weather and a 7-day outlook for wherever the visitor is,
// condensed to what the doṣa engine reads. v5.4.0.
//
// Location: Netlify's own IP geolocation (context.geo), city level. The browser
// is never asked for permission and never sends a location. Coordinates are
// rounded to one decimal (~10 km) before they leave this function, they are not
// logged, and they are not returned to the client — only the city name is.
//
// Weather: MET Norway Locationforecast 2.0 (api.met.no), CC BY 4.0, which allows
// commercial use with credit. Their terms ask for an identifying User-Agent, a
// server-side proxy rather than direct browser calls, and respect for Expires —
// all three are handled here.
//
// Functions API v2 (export default) because only v2 receives context.geo; the
// v1 functions beside it are untouched. Dependency-free: Node 18+ fetch.

const MET = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const UA = 'AyurvedaFoodCompass/5.4 ayurveda-food.com info@ayurveda-food.com';

// Warm-instance cache keyed by rounded coordinates, honouring MET's Expires.
const cache = new Map();

const round1 = (x) => Math.round(Number(x) * 10) / 10;
const json = (status, body, maxAge = 0) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json',
    // Per-visitor answer: never shared caches, briefly in the browser.
    'Cache-Control': maxAge ? `private, max-age=${maxAge}` : 'private, no-store',
  },
});

/** Local calendar date of an ISO instant in a given IANA zone. */
function localDate(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(iso));
  } catch (e) {
    return String(iso).slice(0, 10);
  }
}
function localHour(iso, tz) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)));
  } catch (e) {
    return new Date(iso).getUTCHours();
  }
}

/** MET timeseries → { current, days[] } in the visitor's local calendar. */
export function condense(met, tz) {
  const ts = (met && met.properties && met.properties.timeseries) || [];
  if (!ts.length) return null;

  const pt = (p) => {
    const d = (p.data && p.data.instant && p.data.instant.details) || {};
    const n1 = p.data && p.data.next_1_hours;
    const n6 = p.data && p.data.next_6_hours;
    return {
      time: p.time,
      t: d.air_temperature,
      rh: d.relative_humidity,
      wind: typeof d.wind_speed === 'number' ? d.wind_speed * 3.6 : null,   // m/s → km/h
      cloud: d.cloud_area_fraction,
      // Precipitation as mm per hour, whichever window MET supplies.
      precip: n1 && n1.details && typeof n1.details.precipitation_amount === 'number'
        ? n1.details.precipitation_amount
        : n6 && n6.details && typeof n6.details.precipitation_amount === 'number'
          ? n6.details.precipitation_amount / 6 : 0,
      symbol: ((n1 && n1.summary) || (n6 && n6.summary) || {}).symbol_code || '',
    };
  };

  const first = pt(ts[0]);
  const r1 = (x) => (typeof x === 'number' ? Math.round(x * 10) / 10 : null);
  const current = { t: r1(first.t), rh: r1(first.rh), wind: r1(first.wind), cloud: r1(first.cloud), precip: r1(first.precip), symbol: first.symbol };

  // Daily: daytime hours (08–20 local) carry the day's character; fall back to
  // every point the day has if the forecast only reaches it 6-hourly.
  const byDay = new Map();
  for (const p of ts) {
    const q = pt(p);
    const date = localDate(q.time, tz);
    if (!byDay.has(date)) byDay.set(date, { all: [], day: [] });
    const b = byDay.get(date);
    b.all.push(q);
    const h = localHour(q.time, tz);
    if (h >= 8 && h <= 20) b.day.push(q);
  }

  const avg = (a, k) => { const v = a.map((x) => x[k]).filter((x) => typeof x === 'number'); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const days = [];
  for (const [date, b] of byDay) {
    const pts = b.day.length >= 2 ? b.day : b.all;
    const temps = b.all.map((x) => x.t).filter((x) => typeof x === 'number');
    const wetHours = b.all.filter((x) => x.precip >= 0.2).length;
    days.push({
      date,
      tmin: temps.length ? r1(Math.min(...temps)) : null,
      tmax: temps.length ? r1(Math.max(...temps)) : null,
      t: r1(avg(pts, 't')),
      rh: r1(avg(pts, 'rh')),
      wind: r1(avg(pts, 'wind')),
      cloud: r1(avg(pts, 'cloud')),
      precip: r1(avg(pts, 'precip')),
      wet: b.all.length ? r1(wetHours / b.all.length) : 0,
      symbol: (pts[Math.floor(pts.length / 2)] || {}).symbol || '',
    });
    if (days.length >= 7) break;
  }
  return { current, days };
}

export default async (req, context) => {
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const url = new URL(req.url);
  const tz = /^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+){0,2}$/.test(url.searchParams.get('tz') || '')
    ? url.searchParams.get('tz') : 'UTC';

  const g = (context && context.geo) || {};
  const lat = Number(g.latitude), lon = Number(g.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
    // No location → the app keeps its calendar-season reading. Not an error.
    return json(200, { wx: null, reason: 'no-location' }, 1800);
  }
  const la = round1(lat), lo = round1(lon);
  const place = { city: String(g.city || '').slice(0, 60), country: String((g.country && g.country.code) || '').slice(0, 2) };

  const key = `${la},${lo}`;
  const hit = cache.get(key);
  let met = hit && hit.expires > Date.now() ? hit.body : null;

  if (!met) {
    try {
      const headers = { 'User-Agent': UA, Accept: 'application/json' };
      if (hit && hit.lastModified) headers['If-Modified-Since'] = hit.lastModified;
      const r = await fetch(`${MET}?lat=${la}&lon=${lo}`, { headers, signal: AbortSignal.timeout(6000) });
      if (r.status === 304 && hit) {
        met = hit.body;
      } else if (r.ok) {
        met = await r.json();
      } else {
        return json(200, { wx: null, reason: 'upstream-' + r.status }, 600);
      }
      const exp = Date.parse(r.headers.get('expires') || '') || Date.now() + 30 * 60 * 1000;
      cache.set(key, { body: met, expires: exp, lastModified: r.headers.get('last-modified') || (hit && hit.lastModified) });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
    } catch (e) {
      return json(200, { wx: null, reason: 'upstream-unreachable' }, 600);
    }
  }

  const wx = condense(met, tz);
  if (!wx) return json(200, { wx: null, reason: 'empty' }, 600);
  return json(200, { wx: { place, ...wx, source: 'MET Norway', licence: 'CC BY 4.0' } }, 3600);
};
