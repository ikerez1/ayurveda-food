// node patches/test_weather_v5_4_0.mjs — offline: MET and Netlify geo are stubbed.
const mod = await import(new URL('../Ayurfood/netlify/functions/weather.mjs', import.meta.url));
const handler = mod.default;
// synthetic MET: hourly for 60h then 6-hourly to 7 days, from 2026-11-24T11:00Z
const ts=[]; let t0=Date.parse('2026-11-24T11:00:00Z');
for(let i=0;i<60;i++) ts.push({time:new Date(t0+i*36e5).toISOString(),data:{instant:{details:{air_temperature:2+Math.sin(i/4)*3,relative_humidity:82,wind_speed:4,cloud_area_fraction:90}},next_1_hours:{summary:{symbol_code:i%5?'cloudy':'lightrain'},details:{precipitation_amount:i%5?0:0.6}}}});
for(let i=60;i<170;i+=6) ts.push({time:new Date(t0+i*36e5).toISOString(),data:{instant:{details:{air_temperature:-1,relative_humidity:55,wind_speed:9,cloud_area_fraction:10}},next_6_hours:{summary:{symbol_code:'clearsky_day'},details:{precipitation_amount:0}}}});
let calls=0;
globalThis.fetch=async(u,o)=>{calls++; if(!/api\.met\.no.*lat=48\.2&lon=16\.4$/.test(u)||!/AyurvedaFoodCompass/.test(o.headers['User-Agent'])) throw new Error('bad request '+u);
  return new Response(JSON.stringify({properties:{timeseries:ts}}),{status:200,headers:{expires:new Date(Date.now()+18e5).toUTCString(),'last-modified':'x'}});};
const ctx={geo:{city:'Vienna',country:{code:'AT'},latitude:48.2083,longitude:16.3731}};
let r=await handler(new Request('https://x/.netlify/functions/weather?tz=Europe/Vienna'),ctx); let b=await r.json();
console.log(r.status, r.headers.get('cache-control'), JSON.stringify(b.wx.place), JSON.stringify(b.wx.current));
console.log(b.wx.days.length, JSON.stringify(b.wx.days[0]), JSON.stringify(b.wx.days[4]));
console.log('coords leaked?', /48\.2|16\.4/.test(JSON.stringify(b)));
await handler(new Request('https://x/w?tz=Europe/Vienna'),ctx); console.log('fetch calls after 2nd (cached):',calls);
r=await handler(new Request('https://x/w?tz=../../etc'),{}); console.log(await r.text());
r=await handler(new Request('https://x/w',{method:'POST'}),ctx); console.log(r.status);
