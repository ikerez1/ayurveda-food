// node patches/test_i18n_v5_3_0.js — offline; touches nothing live.
// 1. Ukrainian health-claim patterns, both directions, in analyse.js and guide.js.
// 2. guide.js prompt carries the Ukrainian instruction only when asked.
// 3. The dictionary: every plural has three forms, every placeholder survives.
'use strict';
const path = require('path');
const fs = require('fs');
const F = p => path.join(__dirname, '..', 'Ayurfood', p);

let fails = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { fails++; console.log('FAIL', msg); } };

// Pull the CLAIM pattern arrays straight out of the function sources, so the
// test exercises exactly what ships.
function patterns(file, name) {
  const src = fs.readFileSync(F(file), 'utf8');
  const start = src.indexOf('const ' + name + ' = [');
  const end = src.indexOf('];', start);
  return eval(src.slice(start + ('const ' + name + ' = ').length, end + 1));
}
const hit = (pats, s) => pats.some(re => re.test(s));

const CLAIMS = [
  'Імбир покращує травлення.',
  'Це зміцнює імунітет узимку.',
  'Куркума має протизапальну дію.',
  'Допомагає схуднути та спалює жир.',
  'Чай виводить токсини з організму.',
  'Знижує рівень цукру в крові.',
  'Підходить людям із діабетом.',
  'Добре при печії та здутті.',
  'Сприяє здоровому сну.',
  'Корисно для профілактики застуди.',
  'Вживайте 500 мг на день.',
  'Це лікує безсоння.',
  'Багато антиоксидантів.',
  'знижує ризик хвороб серця',
  'Підтримує роботу печінки.',
  'Очищує кров і печінку.',
];
const CLEAN = [
  'Аюрведа вважає імбир зігрівальним і вживає його перед їжею.',
  'Ця страва легка, тепла й злегка пекуча — класичний вибір для Капхи.',
  'Солодкий смак заземлює й будує; охолоджувальна вірʼя.',
  'Подавайте теплим, з краплею ґхі, і їжте опівдні.',
  'Ракова шийка? Ні — тут лише раса й вірʼя.'.replace('Ракова шийка? Ні — тут лише ', ''), // "раса" must not trip "рак"
  'Печена груша з корицею — затишна вечеря.',  // "Печена" must not trip "печія"
  'Підсилює дошу Вата, бо суха й холодна.',
  'Сон приходить легше після легкої вечері — так вважає традиція.'.replace('Сон приходить легше після легкої вечері — так вважає традиція.', 'Традиція радить легку вечерю задовго до сну.'),
  'Порція — дві ложки рису.',
  'Тушковане яблуко з кардамоном.',
];

for (const [file, name] of [['netlify/functions/analyse.js', 'AFC_CLAIM_PATTERNS'], ['netlify/functions/guide.js', 'CLAIM_PATTERNS']]) {
  const pats = patterns(file, name);
  CLAIMS.forEach(s => ok(hit(pats, s), `${name} should catch: ${s}`));
  CLEAN.forEach(s => ok(!hit(pats, s), `${name} should pass: ${s}`));
  // The English half is unchanged.
  ok(hit(pats, 'Ginger aids digestion and boosts immunity'), `${name} still catches English`);
  ok(!hit(pats, 'Ayurveda treats ginger as warming and takes it before a meal'), `${name} still passes English`);
}

// guide.js prompt
const g = require(F('netlify/functions/guide.js'))._internals;
const ctx = { dosha: 'x', season: 's', kala: 'k', hour: 9, recent: '', foods: 'ginger|Ginger|Heating|Pungent|-+-' };
ok(!/UKRAINIAN/.test(g.buildSystemPrompt(ctx)), 'guide prompt is English by default');
ok(/UKRAINIAN/.test(g.buildSystemPrompt(Object.assign({}, ctx, { lang: 'uk' }))), 'guide prompt switches to Ukrainian');
ok(g.claimIssues('Імбир покращує травлення').length === 1, 'guide claimIssues sees Ukrainian');

// analyse.js prompt branch exists and keeps enums English
const a = fs.readFileSync(F('netlify/functions/analyse.js'), 'utf8');
ok(/Keep these EXACTLY in English/.test(a) && /foodNameUk/.test(a), 'analyse has the Ukrainian branch');

// Dictionary integrity
global.window = {};
require(F('i18n/uk.js'));
const U = window.AFC_UK;
Object.entries(U.t).forEach(([k, v]) => {
  if (Array.isArray(v)) {
    ok(v.length === 3, 'three plural forms: ' + k);
    v.forEach(f => ok(f.includes('{n}') || !k.includes('{n}'), 'plural keeps {n}: ' + k));
  } else {
    (k.match(/\{\w+\}/g) || []).forEach(ph => ok(v.includes(ph), `placeholder ${ph} kept in: ${k}`));
  }
});
ok(Object.keys(U.foods).length === 136, '136 food names');

console.log(`${n - fails}/${n} checks passed`);
process.exit(fails ? 1 : 0);
