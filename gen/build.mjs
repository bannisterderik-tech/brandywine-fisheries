#!/usr/bin/env node
/* Brandywine Fisheries — static site generator.
 *
 * Reads data/*.json, emits ~270 static pages with per-page schema, a sitemap,
 * robots.txt and llms.txt.
 *
 * The rule this generator exists to enforce: every sentence on every page
 * traces to a fact in data/. There is no paragraph-generation step. Where a
 * page needs variety between siblings, it selects between hand-written
 * framings keyed by a hash of the slug — so two pages differ because they were
 * given different true things to say, not because prose was regenerated.
 *
 * Run: node gen/build.mjs [--demo]
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = ROOT;
const DEMO = process.argv.includes('--demo');
const J = f => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));

const B = J('business.json');
const LOC = J('locations.json');
const SP = J('species.json');
const ME = J('methods.json');
const PR = J('products.json');
const GU = J('guides.json');
const CM = J('comparisons.json');
const SE = J('seasons.json');
const FQ = J('faq.json');

const species = SP.species;
const methods = ME.methods;
const bySlug = Object.fromEntries(species.map(s => [s.slug, s]));
const methodBySlug = Object.fromEntries(methods.map(m => [m.slug, m]));
const locations = LOC.locations;
const retail = locations.filter(l => !l.no_retail);

/* ---------- helpers ---------- */
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hash = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const pick = (arr, key) => arr[hash(key) % arr.length];
/* rotate a window over an array so sibling pages never share an identical link grid */
const rotate = (arr, key, n) => { if (!arr.length) return []; const o = hash(key) % arr.length; return Array.from({ length: Math.min(n, arr.length) }, (_, i) => arr[(o + i) % arr.length]); };

const SITE = B.site;
const BASE = (() => { try { return new URL(SITE).pathname.replace(/\/$/, ''); } catch { return ''; } })();
const u = p => BASE + p;
const abs = p => SITE + p;

const NAME = B.name;
const PHONE = B.phone;
const TEL = '+1' + PHONE.replace(/\D/g, '');
const ST = B.store;

/* Titles over ~60 chars get truncated in results. Try the full form, then a
 * shorter brand tag, then the bare lead. */
const fitTitle = (lead, short) => {
  const full = `${lead} | ${NAME}`;
  if (full.length <= 60) return full;
  const mid = `${lead} | Brandywine`;
  if (mid.length <= 60) return mid;
  const s = `${short || lead} | Brandywine`;
  return s.length <= 62 ? s : (short || lead);
};

/* Sentence-case a name without flattening the proper nouns inside it.
 * Naive .toLowerCase() turns "Pacific Halibut" into "pacific halibut" and
 * "Wednesdays, 11am" into "wednesdays, 11am" — both read as sloppy, and both
 * appear thousands of times across a site this size. */
const PROPER = /\b(Pacific|Chinook|Coho|Dungeness|Ahi|Yellowfin|Alderwood|Applewood|Oregon|Charleston|Springfield|Eugene|Corvallis|Bend|Portland|Willamette|Cascades?|Manila|Atlantic|Alaska|Mahi|Sablefish|Brandywine|McKenzie|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mondays|Tuesdays|Wednesdays|Thursdays|Fridays|Saturdays|Sundays|January|February|March|April|May|June|July|August|September|October|November|December|FDA|EPA|IPHC|ICE)\b/g;
/* PROPER carries a single capture group, so String.split() interleaves the
 * matched proper nouns at the odd indices. Lowercase only the even ones and
 * rejoin — no sentinels, nothing to escape, nothing to get wrong. */
const lc = s => String(s).split(PROPER).map((part, i) => (i % 2 ? part : part.toLowerCase())).join('');

/* lc() is for short names ("Pacific Halibut" -> "Pacific halibut"). Fields that
 * run to whole sentences must NOT go through it — it would lowercase the start
 * of every following sentence and flatten organisation names like the
 * International Pacific Halibut Commission. Those use lcFirst, which only
 * un-capitalises the very first letter so the clause can be sewn into a
 * sentence mid-flight. */
const lcFirst = s => { s = String(s).trim(); return s.charAt(0).toLowerCase() + s.slice(1); };

/* Several data fields carry a headline value plus an aside — "Very lean — among
 * the leanest fish in the case". Read whole they are good; concatenated into a
 * larger sentence they produce garbage like "…in the case fat". `head` takes
 * just the headline clause for use inside a sentence. */
const head = t => String(t).split(/[—;(]/)[0].trim().replace(/,$/, '');

/* Meta descriptions get truncated around 155-160 chars. Clamp at a word
 * boundary rather than letting the SERP do it mid-word. */
const clamp = (s, n = 155) => {
  s = String(s).replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:.\-—]$/, '') + '…';
};

/* Two of the market days are in the same city (Eugene Saturday and Eugene
 * Tuesday). Titles and headings have to distinguish them or they collide as
 * duplicates — which is both an SEO fault and genuinely confusing to a reader
 * trying to work out which day to show up. */
const DAYNAME = { Mo: 'Monday', Tu: 'Tuesday', We: 'Wednesday', Th: 'Thursday', Fr: 'Friday', Sa: 'Saturday', Su: 'Sunday' };
const cityCounts = LOC.locations.reduce((m, l) => (m[l.city] = (m[l.city] || 0) + 1, m), {});
const locLabel = l => cityCounts[l.city] > 1 && l.days?.length ? `${l.city} ${DAYNAME[l.days[0]]}` : l.city;

/* Location × species pages only exist for the core list, and only where the
 * item is genuinely sold at that location. Anything that links to one has to
 * ask this first, or the site ships links to pages that were never generated. */
const CORE = ['chinook-salmon', 'coho-salmon', 'pacific-halibut', 'black-cod', 'lingcod', 'pacific-rockfish', 'albacore-tuna', 'dungeness-crab', 'bay-shrimp', 'black-mussels', 'pacific-oysters'];
const soldAt = (loc, s) => {
  if (loc.no_retail) return false;
  /* Fresh oysters and hot chowder are store-only — their own site lists them
   * under the retail store, not the booths. Never generate or link a page
   * claiming market availability for something that isn't at the market. */
  if (s.slug === 'pacific-oysters' && loc.type !== 'store') return false;
  return true;
};
const hasLocPage = (loc, s) => CORE.includes(s.slug) && soldAt(loc, s);

/* ---------- imagery ----------
 * Scenery and food texture only. There are no generated images of the crew,
 * the boat, the storefront, customers, or "our work" anywhere in this map —
 * see IMAGERY.md for why that line exists and where it is drawn. */
const IMG = {
  harbor: 'hero-harbor.jpg', salmon: 'fish-salmon.jpg', halibut: 'fish-halibut.jpg',
  crab: 'fish-crab.jpg', oysters: 'fish-oysters.jpg', smoked: 'shop-smoked.jpg',
  skillet: 'method-pan.jpg', market: 'loc-market.jpg', coast: 'scene-coast.jpg',
  ice: 'tex-ice.jpg', bend: 'scene-bend.jpg', valley: 'scene-valley.jpg',
};
const img = k => u('/assets/img/' + IMG[k]);
const ALT = {
  harbor: 'A small working commercial fishing harbor on the southern Oregon coast at first light, fog low over moored boats and stacked crab pots',
  salmon: 'A whole side of wild Pacific salmon resting on crushed flake ice',
  halibut: 'Thick snow-white Pacific halibut steaks arranged on crushed ice',
  crab: 'Whole cooked Dungeness crabs piled on crushed ice',
  oysters: 'Freshly shucked Pacific oysters on the half shell over crushed ice',
  smoked: 'Sliced alder-smoked salmon fanned across a weathered wooden board with cracked pepper',
  skillet: 'A fish fillet searing skin-side down in a hot cast iron skillet with foaming butter',
  market: 'An empty outdoor farmers market in a downtown park block early in the morning, canopy frames and folding tables under bare trees',
  coast: 'The Oregon coastline in heavy fog, dark basalt sea stacks and wind-bent shore pines above grey surf',
  ice: 'Macro texture of crushed flake ice, cold blue-white crystals and water droplets',
  bend: 'High desert central Oregon, juniper and sage with snow-capped Cascade peaks on the horizon',
  valley: 'Willamette Valley farmland in winter rain, bare oak trees over flooded green fields',
};
const groupImg = g => g === 'salmon' ? 'salmon' : g === 'shellfish' ? 'crab' : g === 'tuna' ? 'halibut' : 'halibut';

/* ---------- CSS ---------- */
const CSS = `
/* ============================================================
   Brandywine Fisheries — editorial system
   Navy #002647 / gold #f1c900, taken from their live stylesheet.
   Everything inlined: zero external requests, zero webfonts.
   ============================================================ */
:root{
 --navy:${B.colors.primary};--gold:${B.colors.accent};
 --ink:#0b1219;--body:#3a4652;--muted:#6f7b88;--faint:#96a1ad;
 --paper:#fcfbf8;--card:#fff;--line:#e8e4db;--sand:#f5f2ea;--deep:#061019;
 --shadow-s:0 1px 2px rgba(11,18,25,.04),0 2px 8px rgba(11,18,25,.04);
 --shadow-m:0 2px 4px rgba(11,18,25,.04),0 12px 32px rgba(11,18,25,.08);
 --shadow-l:0 4px 8px rgba(11,18,25,.05),0 24px 64px rgba(11,18,25,.12);
 --serif:'Iowan Old Style','Palatino Linotype',Palatino,'Book Antiqua',Georgia,serif;
 --sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
 --mono:'SF Mono',SFMono-Regular,ui-monospace,'Roboto Mono',Menlo,monospace;
 --ease:cubic-bezier(.2,.7,.3,1);
 --gut:clamp(20px,4.5vw,44px);
}
@media (prefers-color-scheme:dark){:root{
 --ink:#f2f5f8;--body:#c2ccd6;--muted:#8b98a6;--faint:#6d7a88;
 --paper:#0a1017;--card:#111a23;--line:#1f2b36;--sand:#0e161e;
 --shadow-s:0 1px 2px rgba(0,0,0,.4);--shadow-m:0 12px 32px rgba(0,0,0,.5);--shadow-l:0 24px 64px rgba(0,0,0,.6);
}}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{background:var(--paper);color:var(--body);font:400 17px/1.7 var(--sans);
 -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
 font-feature-settings:'kern' 1,'liga' 1;overflow-x:hidden}
a{color:inherit;text-underline-offset:.18em}
img{max-width:100%;display:block;height:auto}
::selection{background:var(--gold);color:var(--navy)}
:focus-visible{outline:2.5px solid var(--gold);outline-offset:3px;border-radius:3px}

h1,h2,h3,h4{font-family:var(--serif);color:var(--ink);font-weight:600;line-height:1.12;letter-spacing:-.02em}
h1{font-size:clamp(1.95rem,5.6vw,4.4rem);letter-spacing:-.033em}
h2{font-size:clamp(1.55rem,3.1vw,2.35rem);letter-spacing:-.024em}
h3{font-size:1.1rem;letter-spacing:-.012em}
p{max-width:68ch;margin-bottom:1.05em}
strong,b{font-weight:650;color:var(--ink)}
.wrap{max-width:1180px;margin:0 auto;padding:0 var(--gut)}
.narrow{max-width:min(100%,730px)}
.muted{color:var(--muted)}
.lede{font-size:clamp(1.04rem,1.5vw,1.19rem);color:var(--muted);max-width:60ch;margin-bottom:2rem;line-height:1.6}

/* ---------- eyebrow / rules ---------- */
.eyebrow{font:700 .7rem/1 var(--sans);letter-spacing:.19em;text-transform:uppercase;color:var(--gold);
 margin-bottom:1.15rem;display:flex;align-items:center;gap:.7em}
.eyebrow::after{content:"";height:1px;flex:1;max-width:64px;background:currentColor;opacity:.42}

/* ---------- header ---------- */
.top{position:sticky;top:0;z-index:80;background:${B.colors.primary};color:#fff;
 transition:box-shadow .3s var(--ease)}
.top.scrolled{box-shadow:0 6px 28px rgba(0,0,0,.28)}
.top .wrap{display:flex;align-items:center;gap:clamp(14px,2.4vw,30px);min-height:74px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none;color:#fff;margin-right:auto}
.brand img{height:36px;width:36px;filter:brightness(0) invert(1);transition:transform .4s var(--ease)}
.brand:hover img{transform:rotate(-9deg) scale(1.06)}
.brand .bn{font-family:var(--serif);font-size:1.2rem;font-weight:600;letter-spacing:-.022em;display:block;line-height:1.05}
.brand .bs{display:block;font:700 .62rem/1 var(--sans);letter-spacing:.19em;text-transform:uppercase;color:var(--gold);margin-top:5px}
.top nav{display:flex;gap:clamp(13px,1.9vw,24px);flex-wrap:wrap}
.top nav a{color:rgba(255,255,255,.86);text-decoration:none;font-size:.9rem;font-weight:500;
 padding:5px 0;position:relative;transition:color .2s}
.top nav a::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--gold);
 transform:scaleX(0);transform-origin:left;transition:transform .28s var(--ease)}
.top nav a:hover{color:#fff}
.top nav a:hover::after{transform:scaleX(1)}
.callbtn{background:var(--gold);color:${B.colors.primary};padding:.66em 1.2em;border-radius:3px;
 text-decoration:none;font-weight:700;font-size:.88rem;white-space:nowrap;
 transition:transform .2s var(--ease),box-shadow .2s var(--ease)}
.callbtn:hover{transform:translateY(-1.5px);box-shadow:0 8px 20px rgba(241,201,0,.32)}

/* ---------- hero ----------
   The photograph is the point. A heavy diagonal wash used to bury it; this is a
   bottom-weighted scrim that keeps the type legible and lets the image breathe. */
.hero{position:relative;background:var(--deep);color:#fff;isolation:isolate;overflow:hidden}
.hero .bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-2;
 transform:scale(1.045);animation:heroIn 1.5s var(--ease) both}
@keyframes heroIn{from{transform:scale(1.13);opacity:0}to{transform:scale(1.045);opacity:1}}
.hero::before{content:"";position:absolute;inset:0;z-index:-1;
 background:linear-gradient(to top,${B.colors.primary}f5 0%,${B.colors.primary}cc 26%,${B.colors.primary}62 56%,${B.colors.primary}2e 100%)}
/* film grain, drawn not downloaded */
.hero::after{content:"";position:absolute;inset:0;z-index:-1;opacity:.16;pointer-events:none;
 background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.82' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.5'/%3E%3C/svg%3E")}
.hero .wrap{position:relative;padding:clamp(64px,10vw,120px) var(--gut) clamp(46px,6vw,74px)}
.hero.tall .wrap{padding:clamp(112px,17vw,215px) var(--gut) clamp(64px,8vw,104px)}
.hero h1{color:#fff;max-width:17ch;text-wrap:balance;
 text-shadow:0 1px 40px rgba(0,0,0,.45),0 1px 3px rgba(0,0,0,.3)}
.hero .sub{margin-top:1.35rem;font-size:clamp(1.03rem,1.55vw,1.24rem);color:rgba(255,255,255,.9);
 max-width:52ch;line-height:1.58;text-shadow:0 1px 20px rgba(0,0,0,.5)}
.hero .row{display:flex;gap:13px;flex-wrap:wrap;margin-top:2.1rem}
.badges{display:flex;gap:clamp(20px,3.4vw,46px);flex-wrap:wrap;margin-top:2.6rem;padding-top:1.7rem;
 border-top:1px solid rgba(255,255,255,.2)}
.badges div{font-size:.79rem;color:rgba(255,255,255,.68);letter-spacing:.01em}
.badges b{display:block;color:#fff;font:600 1.32rem/1.1 var(--serif);margin-bottom:4px;letter-spacing:-.02em}

.btn{background:var(--gold);color:${B.colors.primary};padding:.86em 1.65em;border-radius:3px;
 text-decoration:none;font-weight:700;font-size:.95rem;display:inline-block;
 transition:transform .2s var(--ease),box-shadow .2s var(--ease),background .2s}
.btn:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(241,201,0,.34)}
.btn.ghost{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.42);box-shadow:none}
.btn.ghost:hover{background:rgba(255,255,255,.13);border-color:rgba(255,255,255,.75);box-shadow:none}

/* ---------- breadcrumbs ---------- */
.crumbs{font-size:.79rem;color:var(--muted);padding:16px 0 0;letter-spacing:.01em}
.crumbs a{color:var(--muted);text-decoration:none;transition:color .18s}
.crumbs a:hover{color:var(--ink);text-decoration:underline}
.crumbs span[aria-hidden]{opacity:.4;margin:0 .18em}

/* ---------- answer block ---------- */
.answer{position:relative;background:var(--card);border:1px solid var(--line);border-left:3px solid var(--gold);
 padding:1.5rem 1.75rem;margin:2.2rem 0 0;border-radius:0 8px 8px 0;box-shadow:var(--shadow-m);
 font-size:1.05rem;line-height:1.66;max-width:74ch}
.answer b{color:var(--ink);font-weight:650}

/* ---------- sections ---------- */
section{padding:clamp(46px,6.5vw,88px) 0;position:relative}
section.band{background:var(--sand)}
section.band+section.band{padding-top:0}
section+section:not(.band):not(.cta)::before{content:"";position:absolute;top:0;left:var(--gut);right:var(--gut);height:1px;background:var(--line)}

/* ---------- reveal on scroll ---------- */
.rv{opacity:0;transform:translateY(18px);transition:opacity .75s var(--ease),transform .75s var(--ease)}
.rv.in{opacity:1;transform:none}
@media (prefers-reduced-motion:reduce){
 *,*::before,*::after{animation-duration:.001ms!important;transition-duration:.001ms!important}
 .rv{opacity:1;transform:none}
 html{scroll-behavior:auto}
}

/* ---------- link cards ---------- */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(244px,1fr));gap:14px}
.grid a{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:1.05rem 1.2rem;
 text-decoration:none;display:block;position:relative;overflow:hidden;
 transition:transform .24s var(--ease),box-shadow .24s var(--ease),border-color .24s}
.grid a::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--gold);
 transform:scaleY(0);transform-origin:top;transition:transform .28s var(--ease)}
.grid a:hover{transform:translateY(-3px);box-shadow:var(--shadow-m);border-color:transparent}
.grid a:hover::before{transform:scaleY(1)}
.grid b{display:block;font-family:var(--serif);font-size:1.06rem;color:var(--ink);margin-bottom:4px;letter-spacing:-.014em}
.grid span{display:block;color:var(--muted);font-size:.865rem;line-height:1.5}
.grid .px{color:var(--ink);font:700 .88rem/1 var(--mono);margin-top:.62rem;display:block;letter-spacing:-.02em}

/* ---------- picture cards ---------- */
.pcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(282px,1fr));gap:20px}
.pcard{background:var(--card);border:1px solid var(--line);border-radius:11px;overflow:hidden;
 text-decoration:none;display:block;
 transition:transform .3s var(--ease),box-shadow .3s var(--ease),border-color .3s}
.pcard .ph{position:relative;overflow:hidden;aspect-ratio:3/2;background:var(--sand)}
.pcard img{width:100%;height:100%;object-fit:cover;transition:transform .7s var(--ease),filter .5s}
.pcard:hover{transform:translateY(-4px);box-shadow:var(--shadow-l);border-color:transparent}
.pcard:hover img{transform:scale(1.062)}
.pcard .bd{padding:1.05rem 1.25rem 1.2rem}
.pcard b{display:block;font-family:var(--serif);font-size:1.16rem;color:var(--ink);margin-bottom:5px;letter-spacing:-.018em}
.pcard p{font-size:.885rem;color:var(--muted);margin:0;line-height:1.52;max-width:none}
.pcard .px{display:inline-block;margin-top:.72rem;color:var(--ink);font:700 .92rem/1 var(--mono);letter-spacing:-.02em}

/* ---------- fact strip ---------- */
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(146px,1fr));gap:1px;margin:1.9rem 0;
 background:var(--line);border:1px solid var(--line);border-radius:9px;overflow:hidden}
.facts div{background:var(--card);padding:1.05rem 1.15rem;font-size:.79rem;color:var(--muted);letter-spacing:.012em}
.facts b{display:block;color:var(--ink);font:600 1.16rem/1.2 var(--serif);margin-bottom:5px;letter-spacing:-.02em}

/* ---------- tables ---------- */
.tscroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:1.6rem 0;
 border:1px solid var(--line);border-radius:9px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:.925rem;min-width:440px}
th,td{text-align:left;padding:.82rem 1.05rem;border-bottom:1px solid var(--line);vertical-align:top}
th{background:var(--sand);font:700 .69rem/1.3 var(--sans);color:var(--ink);
 letter-spacing:.13em;text-transform:uppercase;white-space:nowrap}
tr:last-child td{border-bottom:0}
tbody tr{transition:background .16s}
tbody tr:hover{background:var(--sand)}
td:first-child{font-weight:600;color:var(--ink);width:25%}
table a{color:var(--ink);font-weight:600}

/* ---------- numbered steps ---------- */
ol.steps{margin:1.7rem 0;padding:0;list-style:none;counter-reset:s}
ol.steps li{counter-increment:s;position:relative;padding-left:3.35rem;margin-bottom:1.5rem;max-width:68ch}
ol.steps li::before{content:counter(s,decimal-leading-zero);position:absolute;left:0;top:-1px;
 font:700 .78rem/1 var(--mono);color:var(--gold);background:${B.colors.primary};
 width:2.3rem;height:2.3rem;border-radius:50%;display:grid;place-items:center;letter-spacing:-.03em}
ol.steps b{display:block;font-family:var(--serif);font-size:1.08rem;color:var(--ink);margin-bottom:3px;letter-spacing:-.014em}

/* ---------- faq ---------- */
details{background:var(--card);border:1px solid var(--line);border-radius:8px;margin-bottom:9px;
 overflow:hidden;transition:border-color .2s,box-shadow .2s}
details[open]{box-shadow:var(--shadow-s);border-color:var(--line)}
summary{padding:1.05rem 3.1rem 1.05rem 1.3rem;cursor:pointer;font-weight:600;color:var(--ink);
 list-style:none;position:relative;transition:color .18s;line-height:1.45}
summary::-webkit-details-marker{display:none}
summary::after{content:"";position:absolute;right:1.3rem;top:1.45rem;width:11px;height:11px;
 border-right:2px solid var(--gold);border-bottom:2px solid var(--gold);
 transform:rotate(45deg);transition:transform .28s var(--ease)}
details[open] summary::after{transform:rotate(-135deg);top:1.6rem}
summary:hover{color:var(--gold)}
details p{padding:0 1.3rem 1.15rem;margin:0;color:var(--body);max-width:70ch}

/* ---------- pull quote ---------- */
.pull{position:relative;padding:.3rem 0 .3rem 1.6rem;margin:2rem 0;
 border-left:3px solid var(--gold);font-family:var(--serif);font-size:clamp(1.12rem,1.9vw,1.35rem);
 color:var(--ink);font-style:italic;max-width:58ch;line-height:1.45;letter-spacing:-.012em}
.pull cite{display:block;font:500 .78rem/1.4 var(--sans);font-style:normal;color:var(--muted);
 margin-top:.85rem;letter-spacing:.06em;text-transform:uppercase}

/* ---------- note ---------- */
.note{background:color-mix(in srgb,var(--gold) 8%,var(--card));border:1px solid color-mix(in srgb,var(--gold) 30%,var(--line));
 border-left:3px solid var(--gold);border-radius:0 8px 8px 0;padding:1.05rem 1.3rem;
 font-size:.915rem;color:var(--body);margin:1.6rem 0;max-width:74ch;line-height:1.62}
.note b{color:var(--ink)}

/* ---------- split ---------- */
.split{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.split>div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1.4rem 1.55rem;
 transition:box-shadow .25s var(--ease)}
.split>div:hover{box-shadow:var(--shadow-m)}
.split h3{color:var(--ink);margin-bottom:.5rem}
.split p{font-size:.945rem;margin-bottom:.6rem}
@media(max-width:720px){.split{grid-template-columns:1fr}}

/* ---------- cta ---------- */
.cta{background:${B.colors.primary};color:#fff;text-align:center;overflow:hidden;position:relative}
.cta::before{content:"";position:absolute;inset:0;opacity:.1;
 background:radial-gradient(ellipse at 50% 0%,var(--gold),transparent 62%)}
.cta .wrap{position:relative}
.cta h2{color:#fff}
.cta p{margin:.9rem auto 1.7rem;color:rgba(255,255,255,.8);max-width:54ch}
.cta .row{display:flex;gap:13px;justify-content:center;flex-wrap:wrap}

/* ---------- footer ---------- */
footer{background:var(--deep);color:rgba(255,255,255,.58);font-size:.88rem;padding:clamp(46px,6vw,72px) 0 2rem}
footer h4{color:#fff;font:700 .68rem/1 var(--sans);letter-spacing:.17em;text-transform:uppercase;margin-bottom:1rem}
footer .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(172px,1fr));gap:2.2rem;margin-bottom:2.4rem}
footer a{color:rgba(255,255,255,.58);text-decoration:none;display:block;padding:4px 0;transition:color .18s,transform .18s}
footer a:hover{color:var(--gold);transform:translateX(3px)}
footer p{color:rgba(255,255,255,.58)}
footer .base{border-top:1px solid rgba(255,255,255,.11);padding-top:1.5rem;display:flex;
 justify-content:space-between;gap:1.2rem;flex-wrap:wrap;font-size:.82rem}
footer .base b{color:#fff}
.demobar{position:fixed;bottom:0;left:0;right:0;background:rgba(6,16,25,.96);backdrop-filter:blur(12px);
 color:#fff;z-index:99;padding:.72rem 1.1rem;font-size:.83rem;text-align:center;border-top:2px solid var(--gold)}
body:has(.demobar){padding-bottom:76px}

@media(max-width:680px){
 .top .wrap{min-height:64px;gap:10px}
 .top nav{display:none}
 .brand img{height:32px;width:32px}
 .facts{grid-template-columns:repeat(auto-fit,minmax(128px,1fr))}
 .hero.tall .wrap{padding-top:clamp(78px,20vw,120px)}
}
@media print{
 .top,.cta,footer,.demobar,.hero .bg{display:none}
 body{background:#fff;color:#000;font-size:11pt}
 .hero{background:#fff;color:#000}.hero h1{color:#000;text-shadow:none}
 a{text-decoration:underline}
 details{border:1px solid #ccc}details p{display:block}
}
`;

/* ---------- schema ---------- */
const bizLD = {
  '@context': 'https://schema.org', '@type': 'SeafoodStore', '@id': abs('/#business'),
  name: NAME, legalName: B.legal_name, description: B.tagline, url: abs('/'),
  telephone: PHONE, image: abs('/assets/img/' + IMG.harbor), logo: abs('/assets/logo.png'),
  slogan: B.tagline,
  address: { '@type': 'PostalAddress', streetAddress: ST.street, addressLocality: ST.city, addressRegion: ST.state, postalCode: ST.zip, addressCountry: 'US' },
  geo: { '@type': 'GeoCoordinates', latitude: ST.geo.lat, longitude: ST.geo.lng },
  openingHoursSpecification: [{ '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], opens: '10:00', closes: '18:00' }],
  areaServed: retail.map(l => ({ '@type': 'City', name: l.city })),
  makesOffer: species.filter(s => /^\$/.test(s.price)).slice(0, 12).map(s => ({
    '@type': 'Offer', itemOffered: { '@type': 'Product', name: s.name }, priceCurrency: 'USD',
    price: (s.price.match(/\$([\d.]+)/) || [])[1],
  })),
};
const breadcrumbLD = parts => ({
  '@context': 'https://schema.org', '@type': 'BreadcrumbList',
  itemListElement: parts.map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: p.name, ...(p.url ? { item: abs(p.url.replace(BASE, '')) } : {}) })),
});
const faqLD = qs => ({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: qs.map(q => ({ '@type': 'Question', name: q.q, acceptedAnswer: { '@type': 'Answer', text: q.a } })) });
const listLD = (name, items) => ({ '@context': 'https://schema.org', '@type': 'ItemList', name, numberOfItems: items.length, itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, url: abs(it.url.replace(BASE, '')) })) });

/* ---------- page shell ---------- */
const urls = [];
const NAV = [
  { name: 'Fish', url: u('/fish/') }, { name: 'Shop', url: u('/shop/') },
  { name: 'Where to Buy', url: u('/where-to-buy/') }, { name: 'Guides', url: u('/guides/') },
  { name: "What's in Season", url: u('/season/') }, { name: 'About', url: u('/about/') },
];
const crumb = parts => parts.map((p, i) => i === parts.length - 1 ? `<span>${esc(p.name)}</span>` : `<a href="${p.url}">${esc(p.name)}</a> <span aria-hidden="true">/</span> `).join('');

const HEADER = `<header class="top"><div class="wrap">
<a class="brand" href="${u('/')}"><img src="${u('/assets/logo.png')}" alt="" width="36" height="36"><span><span class="bn">Brandywine Fisheries</span><span class="bs">Oregon Coast Seafood</span></span></a>
<nav>${NAV.map(n => `<a href="${n.url}">${esc(n.name)}</a>`).join('')}</nav>
<a class="callbtn" href="tel:${TEL}">${esc(PHONE)}</a></div></header>`;

const FOOTER = `<footer><div class="wrap">
<div class="cols">
<div><h4>Fish</h4>${species.slice(0, 7).map(s => `<a href="${u(`/fish/${s.slug}/`)}">${esc(s.name)}</a>`).join('')}<a href="${u('/fish/')}">All species →</a></div>
<div><h4>Shop</h4>${PR.categories.map(c => `<a href="${u(`/shop/${c.slug}/`)}">${esc(c.name)}</a>`).join('')}</div>
<div><h4>Where to Buy</h4>${retail.map(l => `<a href="${u(`/where-to-buy/${l.slug}/`)}">${esc(locLabel(l))}${l.type === 'store' ? ' (store)' : ''}</a>`).join('')}</div>
<div><h4>Learn</h4><a href="${u('/guides/')}">Guides</a><a href="${u('/season/')}">What's in season</a><a href="${u('/compare/')}">Compare fish</a><a href="${u('/faq/')}">FAQ</a><a href="${u('/about/')}">About</a><a href="${u('/contact/')}">Contact</a></div>
<div><h4>Store</h4><p style="color:rgba(255,255,255,.62);margin:0 0 6px">${esc(ST.street)}<br>${esc(ST.city)}, ${esc(ST.state)} ${esc(ST.zip)}</p><a href="tel:${TEL}">${esc(PHONE)}</a><p style="color:rgba(255,255,255,.62);margin:6px 0 0;font-size:.85rem">${esc(ST.hours)}</p></div>
</div>
<div class="base"><div><b>${esc(NAME)}</b> — ${esc(B.tagline)}</div><div>Home port: Charleston, Oregon</div></div>
<p style="color:rgba(255,255,255,.42);font-size:.78rem;margin-top:14px;max-width:78ch">Photography on this site is regional Oregon scenery and food styling. It is not photographs of the Brandywine boat, crew, store or catch. Prices and seasons are as published by Brandywine Fisheries and change — the counter at ${esc(PHONE)} is the authority.</p>
</div></footer>`;

const DEMOBAR = DEMO ? `<div class="demobar">Demo build for ${esc(NAME)} — not live, not indexed. <a href="${u('/about/')}" style="color:var(--gold)">About this build</a></div>` : '';

function page({ path, title, desc, sub, h1, eyebrow, answer, body, crumbs, ld = [], hero = 'harbor', tall = false, ogImg }) {
  /* The hero line and the answer block sit within one screen of each other. If
   * both render the meta description the page opens by saying the same thing
   * twice. `sub` lets a template give the hero its own short line.
   *
   * Falling back to the clamped description puts a visible "…" in 60px display
   * type, which reads as broken. Cut the fallback at the last complete sentence
   * instead — a shorter true sentence beats a truncated longer one. */
  const rawDesc = desc;
  desc = clamp(desc);
  const sentenceCut = t => {
    t = String(t).replace(/\s+/g, ' ').trim();
    if (t.length <= 150) return t;
    const c = t.slice(0, 150);
    const i = Math.max(c.lastIndexOf('. '), c.lastIndexOf('! '), c.lastIndexOf('? '));
    return i > 55 ? c.slice(0, i + 1) : clamp(t);
  };
  const heroSub = sub || sentenceCut(rawDesc);
  const canonical = abs(path);
  const heroImg = img(hero), heroAlt = ALT[hero];
  const og = ogImg || abs('/assets/img/' + IMG[hero]);
  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
${DEMO ? '<meta name="robots" content="noindex,nofollow">' : '<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">'}
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${canonical}">
<meta property="og:image" content="${og}"><meta property="og:site_name" content="${esc(NAME)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="${B.colors.primary}">
<link rel="icon" href="${u('/assets/logo.png')}">
<style>${CSS}</style>
<script type="application/ld+json">${JSON.stringify(bizLD)}</script>
${ld.map(x => `<script type="application/ld+json">${JSON.stringify(x)}</script>`).join('\n')}
</head><body>
${HEADER}
${crumbs ? `<div class="wrap"><nav class="crumbs" aria-label="Breadcrumb">${crumbs}</nav></div>` : ''}
<div class="hero${tall ? ' tall' : ''}"><img class="bg" src="${heroImg}" alt="${esc(heroAlt)}" loading="${tall ? 'eager' : 'lazy'}" width="1536" height="1024">
<div class="wrap">${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}<h1>${h1}</h1>
${heroSub ? `<p class="sub">${esc(heroSub)}</p>` : ''}
<div class="row"><a class="btn" href="tel:${TEL}">Call ${esc(PHONE)}</a><a class="btn ghost" href="${u('/where-to-buy/')}">Where to find us</a></div>
</div></div>
${answer ? `<div class="wrap"><div class="answer">${answer}</div></div>` : ''}
<main>${body}</main>
<section class="cta"><div class="wrap"><h2>Come find the case</h2>
<p>The store at ${esc(ST.street)}, ${esc(ST.city)} is open ${esc(lc(ST.hours))}. Five market days a week across Eugene, Corvallis, Bend and Portland. What's in the case depends on what the boat landed — call and ask.</p>
<div class="row"><a class="btn" href="tel:${TEL}">Call ${esc(PHONE)}</a><a class="btn ghost" href="${u('/where-to-buy/')}">All locations</a></div></div></section>
${FOOTER}${DEMOBAR}<script>
(function(){
 var t=document.querySelector('.top');
 if(t){var f=function(){t.classList.toggle('scrolled',window.scrollY>8)};
   addEventListener('scroll',f,{passive:true});f()}
 if(!matchMedia('(prefers-reduced-motion:reduce)').matches&&'IntersectionObserver'in window){
   var els=document.querySelectorAll('main section');
   var io=new IntersectionObserver(function(es){es.forEach(function(e){
     if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})},{rootMargin:'0px 0px -8% 0px'});
   els.forEach(function(e){e.classList.add('rv');io.observe(e)})}
})();
</script></body></html>`;
  const dir = path === '/' ? OUT : join(OUT, path.slice(1, -1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
  urls.push(path);
}

/* clean previous build */
for (const d of ['fish', 'shop', 'where-to-buy', 'guides', 'season', 'compare', 'about', 'contact', 'faq'])
  rmSync(join(OUT, d), { recursive: true, force: true });

const C_HOME = { name: 'Home', url: u('/') };

/* ===================== HOME ===================== */
const featured = ['chinook-salmon', 'pacific-halibut', 'black-cod', 'dungeness-crab', 'albacore-tuna', 'pacific-rockfish'].map(s => bySlug[s]);
page({
  path: '/', tall: true, hero: 'harbor',
  title: 'Brandywine Fisheries | Oregon Coast Seafood, Never Frozen',
  desc: `Never-frozen Oregon seafood from a Charleston boat. Retail store in Springfield open daily 10–6, plus farmers markets in Eugene, Corvallis, Bend and Portland. Call ${PHONE}.`,
  eyebrow: B.tagline,
  sub: `A hand-built boat out of Charleston harbor, an ice hold instead of a freezer, and a store in Springfield open seven days a week.`,
  h1: 'Iced on the boat.<br>Never frozen.',
  answer: `<b>${esc(NAME)}</b> sells never-frozen Oregon seafood from a hand-built boat working out of Charleston harbor. Their retail store at <b>${esc(ST.street)}, ${esc(ST.city)}, OR</b> is open <b>daily 10am–6pm</b> — call <b>${esc(PHONE)}</b>. They also run five farmers market days a week in Eugene (Saturday and Tuesday), Corvallis, Bend and Portland. The case runs from black mussels at $6.95 to halibut at $38.95 a pound, plus a thirteen-piece smokehouse line and their own canned albacore.`,
  body: `
<section><div class="wrap">
<h2>The whole argument, in one sentence</h2>
<p class="lede">Their boat uses an ice hold instead of a freezer — which means it has to come back to the dock more often, and the fish reaches a counter in days rather than weeks.</p>
<div class="pull">${esc(B.facts.ice_hold)} ${esc(B.facts.never_frozen)}<cite>— Brandywine Fisheries, in their own words</cite></div>
<div class="facts"><div><b>${B.facts.vessel_history_years} years</b>the boat's history on this coast</div><div><b>Charleston, OR</b>hand-built, home port</div><div><b>${B.facts.owner_years_on_boat} years</b>the owner on this specific boat</div><div><b>Open daily</b>10am – 6pm in Springfield</div></div>
</div></section>

<section class="band"><div class="wrap">
<h2>What comes off the boat</h2>
<p class="lede">Twenty species and products across the case. Prices are Brandywine's own published prices — what's actually available on a given day depends on what landed.</p>
<div class="pcards">${featured.map(s => `<a class="pcard" href="${u(`/fish/${s.slug}/`)}">
<span class="ph"><img src="${img(groupImg(s.group))}" alt="${esc(ALT[groupImg(s.group)])}" loading="lazy" width="1536" height="1024"></span>
<span class="bd"><b>${esc(s.name)}</b><p>${esc(s.flavor)}</p><span class="px">${esc(s.price)}</span></span></a>`).join('')}</div>
<p style="margin-top:22px"><a class="btn" href="${u('/fish/')}">All ${species.length} species →</a></p>
</div></section>

<section><div class="wrap">
<h2>Five market days a week, plus the store</h2>
<p class="lede">${esc(LOC.climate_note)}</p>
<div class="grid">${retail.map(l => `<a href="${u(`/where-to-buy/${l.slug}/`)}"><b>${esc(locLabel(l))}${l.type === 'store' ? ' — the store' : ''}</b><span>${esc(l.when)}</span><span class="px">${esc(l.address.split(',')[0])}</span></a>`).join('')}</div>
</div></section>

<section class="band"><div class="wrap">
<h2>How to cook it</h2>
<p class="lede">Eight methods, and which fish each one suits. Every page carries real temperatures, real timings, and the mistake people actually make.</p>
<div class="grid">${methods.map(m => `<a href="${u(`/guides/how-to-${m.slug}-fish/`)}"><b>${esc(m.name)}</b><span>${esc(m.one_line)}</span></a>`).join('')}</div>
</div></section>

<section><div class="wrap">
<h2>Worth knowing before you buy</h2>
<div class="grid">${rotate(GU.guides, 'home', 8).map(g => `<a href="${u(`/guides/${g.slug}/`)}"><b>${esc(g.title)}</b><span>${esc(g.question)}</span></a>`).join('')}</div>
<p style="margin-top:22px"><a class="btn" href="${u('/guides/')}">All ${GU.guides.length} guides →</a></p>
</div></section>

<section class="band"><div class="wrap narrow">
<h2>Questions people actually ask</h2>
${FQ.general.slice(0, 8).map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}
<p style="margin-top:18px"><a href="${u('/faq/')}">All questions →</a></p>
</div></section>`,
  ld: [faqLD(FQ.general.slice(0, 8)), listLD('Seafood species', species.map(s => ({ name: s.name, url: u(`/fish/${s.slug}/`) })))],
});

/* ===================== FISH HUB ===================== */
const groups = [
  { key: 'salmon', name: 'Salmon & Steelhead' }, { key: 'whitefish', name: 'Whitefish & Groundfish' },
  { key: 'tuna', name: 'Tuna & Steak Fish' }, { key: 'shellfish', name: 'Crab, Shrimp & Shellfish' },
];
page({
  path: '/fish/', hero: 'salmon',
  title: fitTitle('Every Fish We Sell', 'All Fish'),
  desc: `All ${species.length} species Brandywine Fisheries sells, with prices, seasons, fat content, cooking temperatures and what each one is actually good for.`,
  eyebrow: `${species.length} species`, h1: 'Every fish in the case',
  crumbs: crumb([C_HOME, { name: 'Fish' }]),
  answer: `Brandywine sells <b>${species.length} species and products</b>, from <b>black mussels at $6.95</b> to <b>halibut at $38.95 a pound</b>. ${species.filter(s => s.oregon_fishery).length} are Oregon fisheries landed by the boat out of Charleston; ${species.filter(s => !s.oregon_fishery).length} are sourced items and are marked as such. Every page below carries the real season, gear type, fat content and cooking temperature.`,
  body: groups.map(g => {
    const list = species.filter(s => s.group === g.key);
    return `<section${g.key === 'whitefish' || g.key === 'shellfish' ? ' class="band"' : ''}><div class="wrap"><h2>${esc(g.name)}</h2>
<p class="lede">${list.length} in this group.</p>
<div class="pcards">${list.map(s => `<a class="pcard" href="${u(`/fish/${s.slug}/`)}">
<span class="ph"><img src="${img(groupImg(s.group))}" alt="${esc(ALT[groupImg(s.group)])}" loading="lazy" width="1536" height="1024"></span>
<span class="bd"><b>${esc(s.name)}</b><p>${esc(s.flavor)}${s.oregon_fishery ? '' : ' · Sourced, not an Oregon fishery'}</p><span class="px">${esc(s.price)}</span></span></a>`).join('')}</div></div></section>`;
  }).join(''),
  ld: [breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'Fish' }]), listLD('Seafood species', species.map(s => ({ name: s.name, url: u(`/fish/${s.slug}/`) })))],
});

/* ===================== SPECIES PAGES ===================== */
for (const s of species) {
  const ms = (s.best_methods || []).map(m => methodBySlug[m]).filter(Boolean);
  const subs = (s.substitutes || []).map(x => bySlug[x]).filter(Boolean);
  const cmps = CM.comparisons.filter(c => c.a === s.slug || c.b === s.slug);
  const q = [
    { q: `How much is ${lc(s.name)}?`, a: `${s.price}${s.market_price ? `, or ${s.market_price}.` : '.'} Prices are Brandywine's own published prices and the counter is always the authority — call ${PHONE}.` },
    { q: `What does ${lc(s.name)} taste like?`, a: `${s.flavor}. Texture is ${lc(head(s.texture))}, and the fat content is ${lc(head(s.fat))}.` },
    { q: `What temperature should ${lc(s.name)} be cooked to?`, a: `${s.cook_temp}. ${s.cook_note}` },
    { q: `Is ${lc(s.name)} caught in Oregon?`, a: s.oregon_fishery ? `Yes. ${s.gear} out of Charleston, Oregon. ${s.season}.` : `No. ${s.sourcing}` },
    { q: `When is ${lc(s.name)} available?`, a: `${s.season}. Seasons are set annually and shift year to year — call ${PHONE} to find out what actually landed this week.` },
    { q: `What can I substitute for ${lc(s.name)}?`, a: subs.length ? `${subs.map(x => x.name).join(', ')}. ${subs[0].name} is the closest match on texture and cooking behaviour.` : `Ask at the counter — the right substitute depends on what you're cooking.` },
    { q: `How long does ${lc(s.name)} keep?`, a: `${s.storage}` },
    { q: `How much ${lc(s.name)} per person?`, a: `${s.portion}.` },
  ];
  const qs = rotate(q, s.slug, 6);
  page({
    path: `/fish/${s.slug}/`, hero: groupImg(s.group),
    title: fitTitle(`${s.name} — Price, Season & How to Cook`, s.name),
    desc: `${s.name}${s.aka && !s.name.toLowerCase().includes(s.aka.toLowerCase()) ? ` (${s.aka})` : ''} at Brandywine Fisheries: ${s.price}. ${s.flavor}. ${s.cook_temp}. ${s.oregon_fishery ? `${s.gear}, Charleston OR.` : 'Sourced item.'}`,
    eyebrow: s.oregon_fishery ? 'Oregon fishery' : 'Sourced item',
    sub: `${s.price} · ${head(s.fat).toLowerCase().includes('fat') ? head(s.fat) : head(s.fat) + ' fat'} · cook to ${head(s.cook_temp)} · ${head(s.portion)}`,
    h1: esc(s.name),
    crumbs: crumb([C_HOME, { name: 'Fish', url: u('/fish/') }, { name: s.name }]),
    answer: `<b>${esc(s.name)}</b>${s.aka && !s.name.toLowerCase().includes(s.aka.toLowerCase()) ? ` (${esc(s.aka)})` : ''} is <b>${esc(s.price)}</b> at Brandywine. ${esc(s.flavor)} — ${esc(lc(head(s.fat)))}, ${esc(lc(head(s.texture)))}. Cook it to <b>${esc(s.cook_temp)}</b>. ${s.oregon_fishery ? `It's an Oregon fishery — ${esc(lc(s.gear))}, landed at Charleston.` : `<b>Note:</b> ${esc(s.sourcing)}`}`,
    body: `
<section><div class="wrap">
${!s.oregon_fishery ? `<div class="note"><b>Sourced, not Oregon-landed.</b> ${esc(s.sourcing)} We label this everywhere it appears rather than letting the Oregon boat story imply otherwise.</div>` : ''}
<h2>The specifications</h2>
<div class="tscroll"><table>
<tr><th>Detail</th><th>${esc(s.name)}</th></tr>
<tr><td>Price</td><td>${esc(s.price)}${s.market_price ? ` · ${esc(s.market_price)}` : ''}${s.smoked_price ? ` · ${esc(s.smoked_price)}` : ''}</td></tr>
${s.sci ? `<tr><td>Species</td><td><i>${esc(s.sci)}</i>${s.aka && !s.name.toLowerCase().includes(s.aka.toLowerCase()) ? ` — also called ${esc(lc(s.aka))}` : ''}</td></tr>` : ''}
<tr><td>Fat content</td><td>${esc(s.fat)}</td></tr>
<tr><td>Texture</td><td>${esc(s.texture)}</td></tr>
<tr><td>Flavor</td><td>${esc(s.flavor)}</td></tr>
<tr><td>Color</td><td>${esc(s.color)}</td></tr>
<tr><td>Cook to</td><td>${esc(s.cook_temp)}</td></tr>
<tr><td>Portion</td><td>${esc(s.portion)}</td></tr>
<tr><td>Gear</td><td>${esc(s.gear)}</td></tr>
<tr><td>Season</td><td>${esc(s.season)}</td></tr>
${s.port ? `<tr><td>Port</td><td>${esc(s.port)}, Oregon</td></tr>` : ''}
</table></div>
${s.gear_why ? `<p>${esc(s.gear_why)}</p>` : ''}
<div class="note"><b>On seasons:</b> ${esc(SE.disclaimer)}</div>
</div></section>

<section class="band"><div class="wrap">
<h2>Cooking ${esc(lc(s.name))}</h2>
<p>${esc(s.cook_note)}</p>
<div class="facts"><div><b>${esc(s.cook_temp.split(';')[0])}</b>target temperature</div><div><b>${esc(s.fat.split('—')[0].trim())}</b>fat content</div><div><b>${esc(s.portion.split(';')[0])}</b>per person</div></div>
<div class="grid">${ms.map(m => `<a href="${u(`/fish/${s.slug}/${m.slug}/`)}"><b>${esc(m.verb)} ${esc(lc(s.name))}</b><span>${esc(m.one_line)}</span></a>`).join('')}</div>
</div></section>

<section><div class="wrap">
<h2>Buying and keeping it</h2>
<p><b>At the counter.</b> ${esc(s.buying)}</p>
<p><b>At home.</b> ${esc(s.storage)}</p>
<div class="pull">${esc(s.fact)}</div>
</div></section>

${subs.length ? `<section class="band"><div class="wrap"><h2>If ${esc(lc(s.name))} isn't in the case</h2>
<p class="lede">What the boat landed decides what's available. These are the closest matches.</p>
<div class="grid">${subs.map(x => `<a href="${u(`/fish/${x.slug}/`)}"><b>${esc(x.name)}</b><span>${esc(x.flavor)}</span><span class="px">${esc(x.price)}</span></a>`).join('')}</div></div></section>` : ''}

${cmps.length ? `<section><div class="wrap"><h2>${esc(s.name)} compared</h2>
<div class="grid">${rotate(cmps, s.slug, 6).map(c => { const o = c.a === s.slug ? bySlug[c.b] : bySlug[c.a]; return `<a href="${u(`/compare/${c.a}-vs-${c.b}/`)}"><b>${esc(s.name)} vs ${esc(o.name)}</b><span>${esc(o.price)} vs ${esc(s.price)}</span></a>`; }).join('')}</div></div></section>` : ''}

<section class="band"><div class="wrap narrow"><h2>Questions about ${esc(lc(s.name))}</h2>
${qs.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div></section>

<section><div class="wrap"><h2>Where to buy ${esc(lc(s.name))}</h2>
${retail.some(l => hasLocPage(l, s))
      ? `<div class="grid">${retail.filter(l => hasLocPage(l, s)).map(l => `<a href="${u(`/where-to-buy/${l.slug}/${s.slug}/`)}"><b>${esc(locLabel(l))}</b><span>${esc(l.when)}</span></a>`).join('')}</div>`
      : `<p class="lede">${esc(s.name)} moves in and out of the case with the season and the landing, so there's no fixed location page for it. Ask at any of these — or call ${esc(PHONE)} before you drive.</p>
<div class="grid">${retail.map(l => `<a href="${u(`/where-to-buy/${l.slug}/`)}"><b>${esc(locLabel(l))}</b><span>${esc(l.when)}</span></a>`).join('')}</div>`}
</div></section>`,
    ld: [
      breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'Fish', url: '/fish/' }, { name: s.name }]),
      faqLD(qs),
      {
        '@context': 'https://schema.org', '@type': 'Product', name: s.name, description: `${s.flavor}. ${s.texture}.`,
        image: abs('/assets/img/' + IMG[groupImg(s.group)]), brand: { '@type': 'Brand', name: NAME },
        ...(/^\$/.test(s.price) ? { offers: { '@type': 'Offer', price: (s.price.match(/\$([\d.]+)/) || [])[1], priceCurrency: 'USD', availability: 'https://schema.org/InStock', seller: { '@id': abs('/#business') }, url: abs(`/fish/${s.slug}/`) } } : {}),
      },
    ],
  });

  /* ---------- species × method ---------- */
  for (const m of ms) {
    const mq = [
      { q: `What temperature should ${m.verb.toLowerCase()} ${lc(s.name)} reach?`, a: `${s.cook_temp}. ${m.doneness}` },
      { q: `How long does it take?`, a: `${m.timing} ${s.cook_note}` },
      { q: `Skin on or off?`, a: `${m.skin || 'Depends on the cut — ask at the counter which way it was trimmed.'}` },
      { q: `What's the most common mistake?`, a: `${m.mistake}` },
      { q: `Is ${lc(s.name)} a good fish for this?`, a: `${m.suits} ${s.name} is ${s.fat.toLowerCase().startsWith('very high') || s.fat.toLowerCase().startsWith('high') ? 'fatty, which makes it forgiving here' : s.fat.toLowerCase().startsWith('lean') || s.fat.toLowerCase().startsWith('very lean') ? 'lean, so watch it closely' : 'moderately fatty, which gives you some margin'}.` },
      { q: `What gear do I need?`, a: `${m.gear}` },
      { q: `How much per person?`, a: `${s.portion}.` },
    ];
    const mqs = rotate(mq, s.slug + m.slug, 5);
    page({
      path: `/fish/${s.slug}/${m.slug}/`, hero: m.slug === 'smoke' ? 'smoked' : m.slug === 'raw' ? 'oysters' : 'skillet',
      title: fitTitle(`How to ${m.name.replace(/ing$/, '')} ${s.name}`, `${m.verb} ${s.name}`),
      desc: `${m.gerund} ${lc(s.name)}: ${m.heat}, cook to ${s.cook_temp.split(';')[0]}, ${m.timing.toLowerCase()} ${m.mistake}`,
      eyebrow: m.name, h1: `${esc(m.gerund)} ${esc(lc(s.name))}`,
      sub: `${m.heat} · ${m.timing} Pull at ${head(s.cook_temp)}.`,
      crumbs: crumb([C_HOME, { name: 'Fish', url: u('/fish/') }, { name: s.name, url: u(`/fish/${s.slug}/`) }, { name: m.name }]),
      answer: `To ${esc(lc(m.name.replace(/ing$/, '')))} <b>${esc(lc(s.name))}</b>: ${esc(lcFirst(m.heat))}, cook to <b>${esc(s.cook_temp.split(';')[0])}</b>, roughly ${esc(lcFirst(m.timing))} ${esc(s.name)} is ${esc(lc(head(s.fat)))}, which means ${s.fat.toLowerCase().includes('high') ? 'it forgives a little overshoot' : 'there is very little margin — use a thermometer'}. The mistake to avoid: ${esc(lcFirst(m.mistake))}`,
      body: `
<section><div class="wrap">
<h2>The method</h2>
<ol class="steps">
<li><b>Set the heat</b>${esc(m.heat)}. ${esc(m.gear)}.</li>
<li><b>Prepare the fish</b>${esc(m.technique)}</li>
<li><b>Time it</b>${esc(m.timing)} ${esc(s.cook_note)}</li>
<li><b>Check it</b>${esc(s.cook_temp)}. ${esc(m.doneness)}</li>
</ol>
<div class="facts"><div><b>${esc(m.heat.split(',')[0])}</b>heat</div><div><b>${esc(s.cook_temp.split(';')[0])}</b>pull temperature</div><div><b>${esc(s.portion.split(';')[0])}</b>per person</div><div><b>${esc(s.price)}</b>current price</div></div>
</div></section>

<section class="band"><div class="wrap">
<h2>Why ${esc(lc(s.name))} suits this</h2>
<p>${esc(m.suits)}</p>
<p>${esc(s.name)} is ${esc(lc(head(s.fat)))} with ${esc(lc(head(s.texture)))}. ${esc(s.cook_note)}</p>
${m.skin ? `<p><b>Skin.</b> ${esc(m.skin)}</p>` : ''}
${m.wood ? `<p><b>Wood.</b> ${esc(m.wood)}</p>` : ''}
${m.batter ? `<p><b>Batter.</b> ${esc(m.batter)}</p>` : ''}
${m.liquid ? `<p><b>The liquid.</b> ${esc(m.liquid)}</p>` : ''}
${m.safety ? `<div class="note"><b>Worth knowing.</b> ${esc(m.safety)}</div>` : ''}
<div class="note"><b>The mistake.</b> ${esc(m.mistake)}</div>
</div></section>

<section><div class="wrap">
<h2>Other ways to cook ${esc(lc(s.name))}</h2>
<div class="grid">${ms.filter(x => x.slug !== m.slug).map(x => `<a href="${u(`/fish/${s.slug}/${x.slug}/`)}"><b>${esc(x.verb)}</b><span>${esc(x.one_line)}</span></a>`).join('')}</div>
</div></section>

<section class="band"><div class="wrap">
<h2>Other fish for ${esc(lc(m.gerund))}</h2>
<div class="grid">${rotate(species.filter(x => x.slug !== s.slug && (x.best_methods || []).includes(m.slug)), s.slug + m.slug, 6).map(x => `<a href="${u(`/fish/${x.slug}/${m.slug}/`)}"><b>${esc(x.name)}</b><span>${esc(x.flavor)}</span><span class="px">${esc(x.price)}</span></a>`).join('')}</div>
</div></section>

<section><div class="wrap narrow"><h2>Questions</h2>
${mqs.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div></section>`,
      ld: [
        breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'Fish', url: '/fish/' }, { name: s.name, url: `/fish/${s.slug}/` }, { name: m.name }]),
        faqLD(mqs),
        {
          '@context': 'https://schema.org', '@type': 'HowTo', name: `How to ${lc(m.name.replace(/ing$/, ''))} ${lc(s.name)}`,
          description: `${m.gerund} ${lc(s.name)} to ${s.cook_temp.split(';')[0]}.`,
          image: abs('/assets/img/' + IMG.skillet),
          supply: [{ '@type': 'HowToSupply', name: s.name }],
          tool: [{ '@type': 'HowToTool', name: m.gear }],
          step: [
            { '@type': 'HowToStep', name: 'Set the heat', text: `${m.heat}. ${m.gear}.` },
            { '@type': 'HowToStep', name: 'Prepare the fish', text: m.technique },
            { '@type': 'HowToStep', name: 'Time it', text: `${m.timing} ${s.cook_note}` },
            { '@type': 'HowToStep', name: 'Check it', text: `${s.cook_temp}. ${m.doneness}` },
          ],
        },
      ],
    });
  }
}

/* ===================== METHOD GUIDES (one per method) ===================== */
for (const m of methods) {
  const good = species.filter(s => (s.best_methods || []).includes(m.slug));
  const mq = [
    { q: `What heat should I use?`, a: `${m.heat}. ${m.gear}.` },
    { q: `How long does fish take?`, a: `${m.timing}` },
    { q: `Which fish suits ${lc(m.gerund)}?`, a: `${m.suits} At Brandywine that means ${good.slice(0, 4).map(s => lc(s.name)).join(', ')}.` },
    { q: `What should I avoid ${lc(m.gerund)}?`, a: `${m.avoid}` },
    { q: `What's the most common mistake?`, a: `${m.mistake}` },
    { q: `How do I know when it's done?`, a: `${m.doneness}` },
  ];
  page({
    path: `/guides/how-to-${m.slug}-fish/`, hero: m.slug === 'smoke' ? 'smoked' : m.slug === 'steam' ? 'crab' : m.slug === 'raw' ? 'oysters' : 'skillet',
    title: fitTitle(`How to ${m.name.replace(/ing$/, '')} Fish`, `${m.name} Fish`),
    desc: `${m.gerund} fish: ${m.heat.toLowerCase()}, ${m.timing.toLowerCase()} ${m.mistake} Which species suit it and which don't.`,
    eyebrow: 'Method', h1: `How to ${esc(lc(m.name.replace(/ing$/, '')))} fish`,
    crumbs: crumb([C_HOME, { name: 'Guides', url: u('/guides/') }, { name: m.name }]),
    answer: `<b>${esc(m.gerund)}</b> — ${esc(m.one_line)} Heat: <b>${esc(m.heat)}</b>. Timing: ${esc(lcFirst(m.timing))} Best suited to ${esc(lcFirst(m.suits))} The mistake most people make: ${esc(lcFirst(m.mistake))}`,
    body: `
<section><div class="wrap">
<h2>The technique</h2>
<p>${esc(m.technique)}</p>
<div class="facts"><div><b>${esc(m.heat.split(',')[0])}</b>heat</div><div><b>${esc(m.timing.split('.')[0])}</b>timing</div><div><b>${good.length} species</b>suited to this</div></div>
<div class="split">
<div><h3>Suits</h3><p>${esc(m.suits)}</p></div>
<div><h3>Avoid</h3><p>${esc(m.avoid)}</p></div>
</div>
${m.skin ? `<p><b>Skin.</b> ${esc(m.skin)}</p>` : ''}
${m.wood ? `<p><b>Wood.</b> ${esc(m.wood)}</p>` : ''}
${m.batter ? `<p><b>Batter.</b> ${esc(m.batter)}</p>` : ''}
${m.liquid ? `<p><b>The liquid.</b> ${esc(m.liquid)}</p>` : ''}
${m.safety ? `<div class="note"><b>Worth knowing.</b> ${esc(m.safety)}</div>` : ''}
<div class="note"><b>The mistake.</b> ${esc(m.mistake)}</div>
<p><b>Doneness.</b> ${esc(m.doneness)}</p>
</div></section>

<section class="band"><div class="wrap">
<h2>${esc(m.gerund)}, species by species</h2>
<p class="lede">${good.length} of the ${species.length} things Brandywine sells suit this method. Each page carries that fish's own temperature and timing.</p>
<div class="grid">${good.map(s => `<a href="${u(`/fish/${s.slug}/${m.slug}/`)}"><b>${esc(m.verb)} ${esc(lc(s.name))}</b><span>${esc(s.cook_temp.split(';')[0])}</span><span class="px">${esc(s.price)}</span></a>`).join('')}</div>
</div></section>

<section><div class="wrap">
<h2>Other methods</h2>
<div class="grid">${methods.filter(x => x.slug !== m.slug).map(x => `<a href="${u(`/guides/how-to-${x.slug}-fish/`)}"><b>${esc(x.name)}</b><span>${esc(x.one_line)}</span></a>`).join('')}</div>
</div></section>

<section class="band"><div class="wrap narrow"><h2>Questions</h2>
${mq.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div></section>`,
    ld: [
      breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'Guides', url: '/guides/' }, { name: m.name }]),
      faqLD(mq),
      {
        '@context': 'https://schema.org', '@type': 'HowTo', name: `How to ${lc(m.name.replace(/ing$/, ''))} fish`,
        description: m.one_line, image: abs('/assets/img/' + IMG.skillet),
        tool: [{ '@type': 'HowToTool', name: m.gear }],
        step: [
          { '@type': 'HowToStep', name: 'Heat', text: `${m.heat}. ${m.gear}.` },
          { '@type': 'HowToStep', name: 'Technique', text: m.technique },
          { '@type': 'HowToStep', name: 'Timing', text: m.timing },
          { '@type': 'HowToStep', name: 'Doneness', text: m.doneness },
        ],
      },
    ],
  });
}

/* ===================== GUIDES ===================== */
const allGuideLinks = [
  ...GU.guides.map(g => ({ name: g.title, url: u(`/guides/${g.slug}/`), q: g.question })),
  ...methods.map(m => ({ name: `How to ${lc(m.name.replace(/ing$/, ''))} fish`, url: u(`/guides/how-to-${m.slug}-fish/`), q: m.one_line })),
];
page({
  path: '/guides/', hero: 'ice',
  title: fitTitle('Seafood Guides', 'Guides'),
  desc: `${allGuideLinks.length} guides on buying, storing and cooking Pacific seafood — freshness, temperatures, sustainability, and how the Oregon fisheries actually work.`,
  eyebrow: `${allGuideLinks.length} guides`, h1: 'Guides',
  crumbs: crumb([C_HOME, { name: 'Guides' }]),
  answer: `<b>${allGuideLinks.length} guides</b> covering how to tell if fish is fresh, what "sushi grade" actually means, internal temperatures by species, storing and thawing, shellfish handling, the Oregon fisheries, and eight cooking methods in detail.`,
  body: `
<section><div class="wrap"><h2>Cooking methods</h2>
<div class="grid">${methods.map(m => `<a href="${u(`/guides/how-to-${m.slug}-fish/`)}"><b>How to ${esc(lc(m.name.replace(/ing$/, '')))} fish</b><span>${esc(m.one_line)}</span></a>`).join('')}</div></div></section>
<section class="band"><div class="wrap"><h2>Buying, storing and knowing</h2>
<div class="grid">${GU.guides.map(g => `<a href="${u(`/guides/${g.slug}/`)}"><b>${esc(g.title)}</b><span>${esc(g.question)}</span></a>`).join('')}</div></div></section>`,
  ld: [breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'Guides' }]), listLD('Seafood guides', allGuideLinks)],
});

for (const g of GU.guides) {
  const rel = (g.related || []).map(r => GU.guides.find(x => x.slug === r) || bySlug[r] || methodBySlug[r]).filter(Boolean);
  page({
    path: `/guides/${g.slug}/`, hero: pick(['ice', 'coast', 'harbor', 'market', 'skillet'], g.slug),
    title: fitTitle(g.title, g.title.split(':')[0].split(',')[0]),
    desc: `${g.question} ${g.answer.slice(0, 120)}`,
    eyebrow: 'Guide', h1: esc(g.title),
    crumbs: crumb([C_HOME, { name: 'Guides', url: u('/guides/') }, { name: g.title.split(':')[0] }]),
    answer: `<b>${esc(g.question)}</b> ${esc(g.answer)}`,
    body: `
<section><div class="wrap narrow">
${g.sections.map(sec => `<h2>${esc(sec.h)}</h2><p>${esc(sec.p)}</p>`).join('')}
<div class="pull">${esc(g.takeaway)}</div>
</div></section>
${rel.length ? `<section class="band"><div class="wrap"><h2>Related</h2>
<div class="grid">${rel.map(r => {
      const isGuide = !!r.sections, isSpecies = !!r.group, isMethod = !!r.gerund;
      const url = isGuide ? u(`/guides/${r.slug}/`) : isSpecies ? u(`/fish/${r.slug}/`) : u(`/guides/how-to-${r.slug}-fish/`);
      const label = isGuide ? r.title : isSpecies ? r.name : `How to ${r.name.replace(/ing$/, '').toLowerCase()} fish`;
      const sub = isGuide ? r.question : isSpecies ? r.flavor : r.one_line;
      return `<a href="${url}"><b>${esc(label)}</b><span>${esc(sub)}</span></a>`;
    }).join('')}</div></div></section>` : ''}
<section><div class="wrap"><h2>More guides</h2>
<div class="grid">${rotate(GU.guides.filter(x => x.slug !== g.slug), g.slug, 6).map(x => `<a href="${u(`/guides/${x.slug}/`)}"><b>${esc(x.title)}</b><span>${esc(x.question)}</span></a>`).join('')}</div></div></section>`,
    ld: [
      breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'Guides', url: '/guides/' }, { name: g.title }]),
      faqLD([{ q: g.question, a: g.answer }, ...g.sections.slice(0, 3).map(s => ({ q: s.h, a: s.p }))]),
      { '@context': 'https://schema.org', '@type': 'Article', headline: g.title, description: g.answer, image: abs('/assets/img/' + IMG.ice), publisher: { '@id': abs('/#business') }, mainEntityOfPage: abs(`/guides/${g.slug}/`) },
    ],
  });
}

/* ===================== COMPARE ===================== */
page({
  path: '/compare/', hero: 'halibut',
  title: fitTitle('Compare Fish Side by Side', 'Compare Fish'),
  desc: `${CM.comparisons.length} head-to-head comparisons — price, fat, texture, cooking difficulty and which one to actually buy.`,
  eyebrow: `${CM.comparisons.length} comparisons`, h1: 'Compare fish',
  crumbs: crumb([C_HOME, { name: 'Compare' }]),
  answer: `<b>${CM.comparisons.length} side-by-side comparisons</b> of the species Brandywine sells — on price, fat content, texture, cooking difficulty and what each one is genuinely better at. Every table is built from the same species data as the individual pages, so nothing drifts out of sync.`,
  body: `<section><div class="wrap"><div class="grid">${CM.comparisons.map(c => {
    const a = bySlug[c.a], b = bySlug[c.b];
    return `<a href="${u(`/compare/${c.a}-vs-${c.b}/`)}"><b>${esc(a.name)} vs ${esc(b.name)}</b><span>${esc(a.price)} vs ${esc(b.price)}</span></a>`;
  }).join('')}</div></div></section>`,
  ld: [breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'Compare' }]), listLD('Fish comparisons', CM.comparisons.map(c => ({ name: `${bySlug[c.a].name} vs ${bySlug[c.b].name}`, url: u(`/compare/${c.a}-vs-${c.b}/`) })))],
});

for (const c of CM.comparisons) {
  const a = bySlug[c.a], b = bySlug[c.b];
  const rows = [
    ['Price', a.price, b.price], ['Fat content', a.fat, b.fat], ['Texture', a.texture, b.texture],
    ['Flavor', a.flavor, b.flavor], ['Cook to', a.cook_temp.split(';')[0], b.cook_temp.split(';')[0]],
    ['Portion', a.portion, b.portion], ['Gear', a.gear, b.gear],
    ['Oregon fishery', a.oregon_fishery ? 'Yes — landed by the boat' : 'No — sourced', b.oregon_fishery ? 'Yes — landed by the boat' : 'No — sourced'],
    ['Season', a.season, b.season],
  ];
  const cq = [
    { q: `Which is cheaper, ${lc(a.name)} or ${lc(b.name)}?`, a: `${a.name} is ${a.price}; ${b.name} is ${b.price}.` },
    { q: `Which is easier to cook?`, a: `${a.fat.toLowerCase().includes('high') && !b.fat.toLowerCase().includes('high') ? `${a.name} — more fat means more margin for error.` : b.fat.toLowerCase().includes('high') && !a.fat.toLowerCase().includes('high') ? `${b.name} — more fat means more margin for error.` : `They're comparable. ${a.name} cooks to ${a.cook_temp.split(';')[0]}, ${b.name} to ${b.cook_temp.split(';')[0]}.`}` },
    { q: `Can I substitute one for the other?`, a: `${(a.substitutes || []).includes(b.slug) || (b.substitutes || []).includes(a.slug) ? 'Yes — they are listed as substitutes for each other and behave similarly in the pan.' : 'Not directly. They differ enough in fat and texture that the dish will change. Check each page for its closest match.'}` },
    { q: `Which is the Oregon fish?`, a: `${a.oregon_fishery && b.oregon_fishery ? 'Both. Each is landed by the boat out of Charleston.' : a.oregon_fishery ? `${a.name}. ${b.sourcing}` : b.oregon_fishery ? `${b.name}. ${a.sourcing}` : 'Neither — both are sourced rather than landed by the boat.'}` },
    { q: `Which should I buy?`, a: `${c.verdict}` },
  ];
  page({
    path: `/compare/${c.a}-vs-${c.b}/`, hero: groupImg(a.group),
    title: fitTitle(`${a.name} vs ${b.name}`, `${a.name} vs ${b.name}`),
    desc: `${a.name} (${a.price}) vs ${b.name} (${b.price}) — fat, texture, cooking difficulty and which one to buy. ${c.verdict.slice(0, 90)}`,
    eyebrow: 'Side by side', h1: `${esc(a.name)} vs ${esc(b.name)}`,
    crumbs: crumb([C_HOME, { name: 'Compare', url: u('/compare/') }, { name: `${a.name} vs ${b.name}` }]),
    answer: `<b>${esc(a.name)}</b> is ${esc(a.price)}; <b>${esc(b.name)}</b> is ${esc(b.price)}. ${esc(c.verdict)}`,
    body: `
<section><div class="wrap">
<h2>Side by side</h2>
<div class="tscroll"><table>
<tr><th>&nbsp;</th><th>${esc(a.name)}</th><th>${esc(b.name)}</th></tr>
${rows.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join('')}
</table></div>
<p class="muted" style="font-size:.88rem">Every value in this table is pulled from the same species data as the individual pages — it cannot drift out of sync with them.</p>
</div></section>

<section class="band"><div class="wrap">
<h2>Which one to buy</h2>
<div class="split">
<div><h3>Pick ${esc(a.name.toLowerCase())} when…</h3><p>${esc(c.when_a)}</p><p><a href="${u(`/fish/${a.slug}/`)}">${esc(a.name)} — ${esc(a.price)} →</a></p></div>
<div><h3>Pick ${esc(b.name.toLowerCase())} when…</h3><p>${esc(c.when_b)}</p><p><a href="${u(`/fish/${b.slug}/`)}">${esc(b.name)} — ${esc(b.price)} →</a></p></div>
</div>
<div class="pull">${esc(c.verdict)}</div>
</div></section>

<section><div class="wrap"><h2>Cooking each one</h2>
<div class="grid">${[...(a.best_methods || []).slice(0, 3).map(m => ({ s: a, m: methodBySlug[m] })), ...(b.best_methods || []).slice(0, 3).map(m => ({ s: b, m: methodBySlug[m] }))].filter(x => x.m).map(x => `<a href="${u(`/fish/${x.s.slug}/${x.m.slug}/`)}"><b>${esc(x.m.verb)} ${esc(x.s.name.toLowerCase())}</b><span>${esc(x.s.cook_temp.split(';')[0])}</span></a>`).join('')}</div></div></section>

<section class="band"><div class="wrap narrow"><h2>Questions</h2>
${cq.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div></section>

<section><div class="wrap"><h2>Other comparisons</h2>
<div class="grid">${rotate(CM.comparisons.filter(x => !(x.a === c.a && x.b === c.b)), c.a + c.b, 6).map(x => `<a href="${u(`/compare/${x.a}-vs-${x.b}/`)}"><b>${esc(bySlug[x.a].name)} vs ${esc(bySlug[x.b].name)}</b><span>${esc(bySlug[x.a].price)} vs ${esc(bySlug[x.b].price)}</span></a>`).join('')}</div></div></section>`,
    ld: [breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'Compare', url: '/compare/' }, { name: `${a.name} vs ${b.name}` }]), faqLD(cq)],
  });
}

/* ===================== SHOP ===================== */
page({
  path: '/shop/', hero: 'smoked',
  title: fitTitle('The Shop — Smoked, Canned & Fresh', 'The Shop'),
  desc: `Brandywine's full catalogue: a thirteen-piece smokehouse line, their own canned albacore, fresh fish by the pound, prepared seafood and the tinned pantry shelf.`,
  eyebrow: `${PR.categories.reduce((n, c) => n + c.items.length, 0)} items`, h1: 'The shop',
  crumbs: crumb([C_HOME, { name: 'Shop' }]),
  answer: `Brandywine's catalogue runs to <b>${PR.categories.reduce((n, c) => n + c.items.length, 0)} items</b> across ${PR.categories.length} categories — their own smokehouse line (13 pieces), their own canned albacore, fresh fish by the pound, three prepared items, an imported tinned shelf, and gift sets. Prices below are their published prices; the counter is always the authority.`,
  body: PR.categories.map((c, i) => `<section${i % 2 ? ' class="band"' : ''}><div class="wrap">
<h2>${esc(c.name)}</h2>
<p class="lede">${esc(c.blurb)}${c.own_production ? '' : ' These are goods Brandywine resells, not products they make.'}</p>
<div class="grid">${c.items.slice(0, 8).map(it => `<a href="${u(`/shop/${c.slug}/`)}"><b>${esc(it.name)}</b><span>${esc(it.note || (it.brand ? it.brand : ''))}</span><span class="px">${esc(it.price)}</span></a>`).join('')}</div>
<p style="margin-top:20px"><a class="btn" href="${u(`/shop/${c.slug}/`)}">All ${c.items.length} in ${esc(c.name.toLowerCase())} →</a></p>
</div></section>`).join(''),
  ld: [breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'Shop' }]), listLD('Product categories', PR.categories.map(c => ({ name: c.name, url: u(`/shop/${c.slug}/`) })))],
});

for (const c of PR.categories) {
  const prices = c.items.map(i => parseFloat((i.price.match(/\$([\d.]+)/) || [])[1])).filter(n => !isNaN(n));
  const lo = Math.min(...prices), hi = Math.max(...prices);
  page({
    path: `/shop/${c.slug}/`, hero: c.slug === 'smoked-fish' ? 'smoked' : c.slug === 'fresh-seafood' ? 'salmon' : c.slug === 'prepared-seafood' ? 'crab' : 'oysters',
    title: fitTitle(`${c.name} — Prices`, c.name),
    desc: `${c.name} at Brandywine Fisheries: ${c.items.length} items from $${lo.toFixed(2)} to $${hi.toFixed(2)}. ${c.blurb}`,
    eyebrow: `${c.items.length} items`, h1: esc(c.name),
    crumbs: crumb([C_HOME, { name: 'Shop', url: u('/shop/') }, { name: c.name }]),
    answer: `<b>${esc(c.name)}</b> — ${c.items.length} items, from <b>$${lo.toFixed(2)}</b> to <b>$${hi.toFixed(2)}</b>. ${esc(c.blurb)} ${c.own_production ? "This is Brandywine's own production." : 'These are goods Brandywine resells rather than makes.'}`,
    body: `
<section><div class="wrap">
${!c.own_production ? `<div class="note"><b>Resold goods.</b> The producers below — ${[...new Set(c.items.map(i => i.brand).filter(Boolean))].join(', ')} — are independent makers whose products Brandywine carries. They are not Brandywine products.</div>` : ''}
<div class="tscroll"><table>
<tr><th>Item</th><th>Price</th><th>Notes</th></tr>
${c.items.map(it => `<tr><td>${esc(it.name)}</td><td>${esc(it.price)}${it.half ? `<br><span class="muted">${esc(it.half)}</span>` : ''}${it.single ? `<br><span class="muted">${esc(it.single)}</span>` : ''}</td><td>${esc(it.note || (it.brand ? `${it.brand}` : '—'))}</td></tr>`).join('')}
</table></div>
<p class="muted" style="font-size:.88rem">Prices as published by Brandywine Fisheries. They change — call ${esc(PHONE)} to confirm anything specific.</p>
</div></section>

${c.items.some(i => i.species) ? `<section class="band"><div class="wrap"><h2>The fish behind these</h2>
<div class="grid">${[...new Set(c.items.map(i => i.species).filter(Boolean))].map(sl => bySlug[sl]).filter(Boolean).map(s => `<a href="${u(`/fish/${s.slug}/`)}"><b>${esc(s.name)}</b><span>${esc(s.flavor)}</span><span class="px">${esc(s.price)}</span></a>`).join('')}</div></div></section>` : ''}

<section><div class="wrap"><h2>Other categories</h2>
<div class="grid">${PR.categories.filter(x => x.slug !== c.slug).map(x => `<a href="${u(`/shop/${x.slug}/`)}"><b>${esc(x.name)}</b><span>${esc(x.blurb)}</span></a>`).join('')}</div></div></section>`,
    ld: [
      breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'Shop', url: '/shop/' }, { name: c.name }]),
      { '@context': 'https://schema.org', '@type': 'OfferCatalog', name: c.name, numberOfItems: c.items.length, itemListElement: c.items.map((it, i) => ({ '@type': 'Offer', position: i + 1, itemOffered: { '@type': 'Product', name: it.name }, priceCurrency: 'USD', price: (it.price.match(/\$([\d.]+)/) || [])[1] })) },
    ],
  });
}

/* ===================== WHERE TO BUY ===================== */
page({
  path: '/where-to-buy/', hero: 'market',
  title: fitTitle('Where to Buy — Store & Markets', 'Where to Buy'),
  desc: `The Springfield store is open daily 10–6. Five farmers market days a week: Eugene Saturday and Tuesday, Corvallis Saturday, Bend Wednesday, Portland PSU Saturday.`,
  eyebrow: `${retail.length} places to find us`, h1: 'Where to buy',
  crumbs: crumb([C_HOME, { name: 'Where to buy' }]),
  answer: `The <b>Springfield store</b> at ${esc(ST.street)} is open <b>daily 10am–6pm</b> — the only Brandywine counter open seven days a week. Beyond that there are <b>five market days</b>: Eugene Saturday 9–3 and Tuesday 10–3, Corvallis Saturday 9–1, Bend Wednesday 11–3, and Portland PSU Saturday 8:30–2.`,
  body: `
<section><div class="wrap">
<h2>The store</h2>
<div class="pcards">${locations.filter(l => l.type === 'store').map(l => `<a class="pcard" href="${u(`/where-to-buy/${l.slug}/`)}">
<span class="ph"><img src="${img('oysters')}" alt="${esc(ALT.oysters)}" loading="lazy" width="1536" height="1024"></span>
<span class="bd"><b>${esc(l.name)}</b><p>${esc(l.address)}</p><span class="px">${esc(l.when)}</span></span></a>`).join('')}</div>
</div></section>
<section class="band"><div class="wrap">
<h2>The markets</h2>
<p class="lede">Five market days a week across four cities. The short markets — Corvallis and Bend, four hours each — are where pre-ordering matters most.</p>
<div class="tscroll"><table>
<tr><th>Market</th><th>Day & time</th><th>Where</th></tr>
${locations.filter(l => l.type === 'market').map(l => `<tr><td><a href="${u(`/where-to-buy/${l.slug}/`)}">${esc(locLabel(l))}</a></td><td>${esc(l.when)}</td><td>${esc(l.address)}</td></tr>`).join('')}
</table></div>
</div></section>
<section><div class="wrap">
<h2>The home port</h2>
<div class="grid">${locations.filter(l => l.no_retail).map(l => `<a href="${u(`/where-to-buy/${l.slug}/`)}"><b>${esc(l.name)}</b><span>${esc(l.blurb)}</span></a>`).join('')}</div>
</div></section>`,
  ld: [breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'Where to buy' }]), listLD('Locations', locations.map(l => ({ name: l.name, url: u(`/where-to-buy/${l.slug}/`) })))],
});

for (const l of locations) {
  const isStore = l.type === 'store';
  const LL = locLabel(l);
  const localSpecies = CORE.map(sl => bySlug[sl]).filter(s => s && hasLocPage(l, s));
  const lq = [
    { q: `When is Brandywine in ${l.city}?`, a: l.no_retail ? `${l.city} is not a retail location — it's the home port of the boat.` : `${l.when}. ${l.address}.` },
    { q: `Can I pre-order for ${l.city}?`, a: l.pre_order ? `Yes. The market pre-order list covers the fresh fish and most of the smoked line, including half-pound portions. It matters most here${l.close && l.open && (parseInt(l.close) - parseInt(l.open)) <= 4 ? ' — this is a four-hour market and popular cuts go early' : ''}.` : isStore ? `The store is open daily 10am–6pm, so there's no need — but call ${PHONE} to have something set aside.` : `Call ${PHONE} to ask.` },
    { q: `What's available in ${l.city}?`, a: isStore ? `Everything: ${ST.carries.join(', ').toLowerCase()}. The store is the only counter with fresh oysters and hot clam chowder.` : `The fresh case and the smoked line. Fresh oysters and hot chowder are store-only and don't travel to the booths.` },
    { q: `How far is ${l.city} from the store?`, a: `${l.drive_note}` },
    { q: `What should I bring?`, a: `A cooler with ice, especially in summer. Make the fish stand your last stop and drive straight home.` },
  ];
  page({
    path: `/where-to-buy/${l.slug}/`, hero: isStore ? 'oysters' : l.slug === 'bend' ? 'bend' : l.no_retail ? 'harbor' : 'market',
    title: fitTitle(`${LL}${isStore ? ' Store' : l.no_retail ? ' — Home Port' : ' Farmers Market'}`, LL),
    desc: l.no_retail ? `${l.blurb} ${l.context}` : `Brandywine Fisheries at ${l.name}: ${l.when}. ${l.address}. Never-frozen Oregon seafood. Call ${PHONE}.`,
    eyebrow: isStore ? 'Retail store' : l.no_retail ? 'Home port' : 'Farmers market',
    h1: `${esc(NAME)} in ${esc(LL)}`,
    crumbs: crumb([C_HOME, { name: 'Where to buy', url: u('/where-to-buy/') }, { name: LL }]),
    answer: l.no_retail
      ? `<b>${esc(l.name)}</b> — ${esc(l.blurb)} This is not a retail location; it's where the boat works from.`
      : `<b>${esc(l.name)}</b> — ${esc(l.when)}, at ${esc(l.address)}. ${esc(l.blurb)}${l.pre_order ? ' Pre-ordering is available.' : ''} Call <b>${esc(PHONE)}</b>.`,
    body: `
<section><div class="wrap">
<h2>${l.no_retail ? 'The port' : 'The details'}</h2>
${!l.no_retail ? `<div class="facts"><div><b>${esc(l.when.split(',')[0])}</b>${esc(l.when.split(',').slice(1).join(',').trim() || 'when')}</div><div><b>${esc(l.city)}, OR</b>${esc(l.county)} County</div><div><b>${esc(l.address.split(',')[0])}</b>where</div>${l.year_round ? '<div><b>Year-round</b>season</div>' : '<div><b>Seasonal</b>see below</div>'}</div>` : ''}
<p>${esc(l.context)}</p>
${l.drive_note ? `<p>${esc(l.drive_note)}</p>` : ''}
${l.season ? `<p><b>Season.</b> ${esc(l.season)}</p>` : ''}
${l.distance_note ? `<div class="note"><b>Why the drive matters here.</b> Everything sold in ${esc(l.city)} has already crossed the Cascades from the coast. A boat that ices rather than freezes has to dock often for that trip to be worth making — which is the entire argument. Bring a cooler for the leg home.</div>` : ''}
${isStore ? `<h2 style="margin-top:34px">What's always here</h2><div class="grid">${ST.carries.map(x => `<a href="${u('/shop/')}"><b>${esc(x)}</b><span>Listed as always carried</span></a>`).join('')}</div>` : ''}
</div></section>

${!l.no_retail ? `<section class="band"><div class="wrap">
<h2>What to buy in ${esc(LL)}</h2>
<p class="lede">What's actually in the case depends on what the boat landed that week. These are the core items — each page carries the real season and the real price.</p>
<div class="grid">${localSpecies.map(s => `<a href="${u(`/where-to-buy/${l.slug}/${s.slug}/`)}"><b>${esc(s.name)} in ${esc(LL)}</b><span>${esc(s.season.slice(0, 62))}…</span><span class="px">${esc(s.price)}</span></a>`).join('')}</div>
</div></section>` : `<section class="band"><div class="wrap"><h2>About the boat</h2>
<p>${esc(B.facts.vessel_history_claim)} ${esc(B.facts.hand_built)} ${esc(B.facts.harbor)}</p>
<p>${esc(B.facts.ice_hold)} ${esc(B.facts.never_frozen)}</p>
<div class="pull">${esc(B.facts.bycatch)}<cite>— Brandywine Fisheries on their fishing methods</cite></div>
</div></section>`}

<section><div class="wrap narrow"><h2>Questions about ${esc(LL)}</h2>
${lq.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div></section>

<section class="band"><div class="wrap"><h2>Other locations</h2>
<div class="grid">${locations.filter(x => x.slug !== l.slug).map(x => `<a href="${u(`/where-to-buy/${x.slug}/`)}"><b>${esc(locLabel(x))}</b><span>${esc(x.when)}</span></a>`).join('')}</div></div></section>`,
    ld: [
      breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'Where to buy', url: '/where-to-buy/' }, { name: LL }]),
      faqLD(lq),
      ...(l.no_retail ? [] : [{
        '@context': 'https://schema.org', '@type': isStore ? 'SeafoodStore' : 'Event',
        name: l.name, description: l.blurb,
        ...(isStore
          ? { telephone: PHONE, address: { '@type': 'PostalAddress', streetAddress: ST.street, addressLocality: ST.city, addressRegion: 'OR', postalCode: ST.zip, addressCountry: 'US' }, openingHours: 'Mo-Su 10:00-18:00' }
          : { eventSchedule: { '@type': 'Schedule', byDay: l.days.map(d => `https://schema.org/${{ Mo: 'Monday', Tu: 'Tuesday', We: 'Wednesday', Th: 'Thursday', Fr: 'Friday', Sa: 'Saturday', Su: 'Sunday' }[d]}`), startTime: l.open, endTime: l.close }, location: { '@type': 'Place', name: l.name, address: { '@type': 'PostalAddress', streetAddress: l.address, addressLocality: l.city, addressRegion: 'OR', addressCountry: 'US' } }, organizer: { '@id': abs('/#business') } }),
      }]),
    ],
  });

  /* ---------- location × species ---------- */
  if (l.no_retail) continue;
  for (const s of localSpecies) {
    const ms2 = (s.best_methods || []).map(m => methodBySlug[m]).filter(Boolean);

    /* Sibling location pages must differ by more than a swapped city name, or
     * they are doorway pages regardless of intent. These angles are DERIVED —
     * each one is a fact computed from this location's real hours and this
     * species' real price, not a rephrasing. A page only gets an angle that is
     * actually true of it, so the set differs genuinely from location to
     * location and from fish to fish. */
    const mins = t => t ? parseInt(t.slice(0, 2)) * 60 + parseInt(t.slice(3)) : null;
    const hrs = l.open && l.close ? (mins(l.close) - mins(l.open)) / 60 : null;
    const num = x => parseFloat((String(x.price).match(/\$([\d.]+)/) || [])[1]);
    const localPrices = localSpecies.map(num).filter(n => !isNaN(n));
    const myPrice = num(s);
    const angles = [];
    if (l.type === 'store')
      angles.push(`The store is open seven days a week, which makes it the one Brandywine counter where ${lc(s.name)} doesn't depend on catching the right market day.`);
    if (l.type === 'market' && hrs && hrs <= 4)
      angles.push(`${l.name} runs ${hrs} hours — a short window against a finite amount of fish. That is precisely what the pre-order list is for.`);
    if (l.type === 'market' && hrs && hrs > 4)
      angles.push(`At ${hrs} hours this is one of the longer market days, so there is more room to arrive late and still find something in the case.`);
    if (!isNaN(myPrice) && localPrices.length > 1 && myPrice === Math.max(...localPrices))
      angles.push(`At ${s.price}, ${lc(s.name)} is the most expensive thing Brandywine brings to ${l.city}. Worth reserving rather than hoping.`);
    if (!isNaN(myPrice) && localPrices.length > 1 && myPrice === Math.min(...localPrices))
      angles.push(`At ${s.price}, ${lc(s.name)} is the least expensive thing on the ${l.city} table — the cheapest way to leave with something off this boat.`);
    if (!l.year_round && l.season)
      angles.push(`There are two seasons to line up here, not one. ${l.season} And for the fish: ${lcFirst(s.season)}.`);
    if (l.year_round && l.type === 'market')
      angles.push(`${l.name} runs year-round, which makes it one of the few places to look for ${lc(s.name)} outside the summer market season.`);
    if (s.storage)
      angles.push(`${l.drive_note} Once it is yours the clock is yours too — ${lcFirst(s.storage)}`);
    const chosen = rotate(angles, l.slug + s.slug, 2);
    const sq = [
      { q: `Where can I buy ${lc(s.name)} in ${l.city}?`, a: `${l.name} — ${l.when}, at ${l.address}. ${s.name} is ${s.price}.` },
      { q: `Is ${lc(s.name)} available all year in ${l.city}?`, a: `${s.season}. ${l.year_round ? `This location runs year-round.` : `This market is seasonal — ${l.season || 'it does not run all year.'}`} Seasons shift annually, so call ${PHONE} first.` },
      { q: `Can I pre-order ${lc(s.name)} for ${l.city}?`, a: l.pre_order ? `Yes — the market pre-order list covers the fresh case and most of the smoked line. Worth doing here, since what's on the table is finite.` : `The store is open daily 10–6. Call ${PHONE} to have something set aside.` },
      { q: `How much ${lc(s.name)} should I buy?`, a: `${s.portion}. It's ${s.price}.` },
      { q: `How do I get it home from ${l.city}?`, a: `A cooler with ice, the fish sitting on top of the ice rather than buried in it, and a straight drive. ${l.drive_note}` },
      { q: `How should I cook it?`, a: `${s.cook_note} Target ${s.cook_temp}.` },
    ];
    const sqs = rotate(sq, l.slug + s.slug, 5);
    page({
      path: `/where-to-buy/${l.slug}/${s.slug}/`, hero: isStore ? groupImg(s.group) : l.slug === 'bend' ? 'bend' : 'market',
      title: fitTitle(`${s.name} in ${LL}, OR`, `${s.name} — ${LL}`),
      desc: `Buy ${lc(s.name)} in ${l.city}, OR from Brandywine Fisheries — ${l.when}, ${l.address}. ${s.price}. Never frozen, iced on the boat.`,
      eyebrow: `${LL}, Oregon`, h1: `${esc(s.name)} in ${esc(LL)}`,
      sub: `${l.when} · ${l.address.split(',')[0]} · ${s.price}`,
      crumbs: crumb([C_HOME, { name: 'Where to buy', url: u('/where-to-buy/') }, { name: LL, url: u(`/where-to-buy/${l.slug}/`) }, { name: s.name }]),
      answer: `Buy <b>${esc(lc(s.name))}</b> in <b>${esc(l.city)}, Oregon</b> from ${esc(NAME)} at ${esc(l.name)} — <b>${esc(l.when)}</b>, ${esc(l.address)}. It's <b>${esc(s.price)}</b>. ${esc(s.season)}.${l.pre_order ? ' Pre-ordering is available.' : ''}`,
      body: `
<section><div class="wrap">
<h2>Getting it in ${esc(LL)}</h2>
<div class="facts"><div><b>${esc(l.when.split(',')[0])}</b>${esc(l.when.split(',').slice(1).join(',').trim() || 'open')}</div><div><b>${esc(s.price)}</b>price</div><div><b>${esc(l.address.split(',')[0])}</b>where</div><div><b>${esc(s.cook_temp.split(';')[0])}</b>cook to</div></div>
<p>${esc(l.context)} ${esc(l.blurb)}</p>
${chosen.map(a => `<p>${esc(a)}</p>`).join('')}
${l.pre_order ? `<p><b>Pre-ordering.</b> ${esc(l.city)} runs ${esc(l.when)}, and what's on the table is finite. The pre-order list covers the fresh case and most of the smoked line — <a href="${u('/guides/market-pre-order/')}">how it works</a>.</p>` : ''}
${l.distance_note ? `<div class="note"><b>The Cascade crossing.</b> Everything sold in ${esc(l.city)} has already come over the mountains from Charleston. Bring a cooler for the leg home — the boat's careful work is undone by two hours on a warm car seat.</div>` : ''}
</div></section>

<section class="band"><div class="wrap">
<h2>About the ${esc(lc(s.name))}</h2>
<p><b>Flavor.</b> ${esc(s.flavor)}. <b>Texture.</b> ${esc(s.texture)}. <b>Fat.</b> ${esc(s.fat)}.</p>
<p>${esc(s.cook_note)}</p>
${s.oregon_fishery ? `<p><b>Where it comes from.</b> ${esc(s.gear)}, landed at ${esc(s.port || 'Charleston')}, Oregon. ${esc(s.season)}.</p>` : `<div class="note"><b>Sourced, not Oregon-landed.</b> ${esc(s.sourcing)}</div>`}
<p><b>Buying it.</b> ${esc(s.buying)}</p>
<p><b>Keeping it.</b> ${esc(s.storage)}</p>
<p><a class="btn" href="${u(`/fish/${s.slug}/`)}">Full ${esc(lc(s.name))} page →</a></p>
</div></section>

<section><div class="wrap">
<h2>Cooking it</h2>
<div class="grid">${ms2.map(m => `<a href="${u(`/fish/${s.slug}/${m.slug}/`)}"><b>${esc(m.verb)}</b><span>${esc(m.one_line)}</span></a>`).join('')}</div>
</div></section>

<section class="band"><div class="wrap">
<h2>Other fish in ${esc(LL)}</h2>
<div class="grid">${rotate(localSpecies.filter(x => x.slug !== s.slug), l.slug + s.slug, 6).map(x => `<a href="${u(`/where-to-buy/${l.slug}/${x.slug}/`)}"><b>${esc(x.name)}</b><span>${esc(x.flavor)}</span><span class="px">${esc(x.price)}</span></a>`).join('')}</div>
</div></section>

<section><div class="wrap">
<h2>${esc(s.name)} elsewhere</h2>
<div class="grid">${retail.filter(x => x.slug !== l.slug && hasLocPage(x, s)).map(x => `<a href="${u(`/where-to-buy/${x.slug}/${s.slug}/`)}"><b>${esc(locLabel(x))}</b><span>${esc(x.when)}</span></a>`).join('')}</div>
</div></section>

<section class="band"><div class="wrap narrow"><h2>Questions</h2>
${sqs.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div></section>`,
      ld: [
        breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'Where to buy', url: '/where-to-buy/' }, { name: LL, url: `/where-to-buy/${l.slug}/` }, { name: s.name }]),
        faqLD(sqs),
        ...(/^\$/.test(s.price) ? [{
          '@context': 'https://schema.org', '@type': 'Product', name: `${s.name} — ${l.city}, OR`,
          description: `${s.flavor}. Available from ${NAME} at ${l.name}, ${l.when}.`,
          image: abs('/assets/img/' + IMG[groupImg(s.group)]), brand: { '@type': 'Brand', name: NAME },
          offers: { '@type': 'Offer', price: (s.price.match(/\$([\d.]+)/) || [])[1], priceCurrency: 'USD', availability: 'https://schema.org/InStock', seller: { '@id': abs('/#business') }, areaServed: { '@type': 'City', name: l.city }, url: abs(`/where-to-buy/${l.slug}/${s.slug}/`) },
        }] : []),
      ],
    });
  }
}

/* ===================== SEASONS ===================== */
page({
  path: '/season/', hero: 'valley',
  title: fitTitle("What's in Season, Month by Month", 'Seasons'),
  desc: `The Oregon seafood year, month by month — what's typically landing, which markets are running, and what to cook. Seasons shift annually.`,
  eyebrow: 'The year', h1: "What's in season",
  crumbs: crumb([C_HOME, { name: 'Season' }]),
  answer: `The Oregon seafood year in twelve pages. Broadly: <b>crab</b> from a December opening into August, <b>halibut</b> from spring, <b>pink shrimp</b> April to October, <b>salmon</b> from May with coho concentrated in late summer, and <b>albacore</b> July to October. Groundfish — black cod, rockfish, lingcod, sole — runs across most of the year.`,
  body: `
<section><div class="wrap">
<div class="note"><b>Read this first.</b> ${esc(SE.disclaimer)}</div>
<div class="pcards">${SE.months.map(m => `<a class="pcard" href="${u(`/season/${m.slug}/`)}">
<span class="ph"><img src="${img(m.n <= 2 || m.n >= 11 ? 'valley' : m.n <= 5 ? 'coast' : 'harbor')}" alt="${esc(ALT[m.n <= 2 || m.n >= 11 ? 'valley' : m.n <= 5 ? 'coast' : 'harbor'])}" loading="lazy" width="1536" height="1024"></span>
<span class="bd"><b>${esc(m.name)}</b><p>${esc(m.headline)}</p></span></a>`).join('')}</div>
</div></section>`,
  ld: [breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'Season' }]), listLD('Seafood seasons by month', SE.months.map(m => ({ name: m.name, url: u(`/season/${m.slug}/`) })))],
});

for (const m of SE.months) {
  const land = m.landing.map(sl => bySlug[sl]).filter(Boolean);
  const prev = SE.months[(m.n + 10) % 12], next = SE.months[m.n % 12];
  const mq = [
    { q: `What seafood is in season in ${m.name} in Oregon?`, a: `Typically ${land.map(s => lc(s.name)).join(', ')}. ${m.note}` },
    { q: `Which markets are running in ${m.name}?`, a: `${m.markets}` },
    { q: `What should I cook in ${m.name}?`, a: `${m.cook}` },
    { q: `What's the best buy in ${m.name}?`, a: `${m.buy}` },
    { q: `Are these dates guaranteed?`, a: `No. ${SE.disclaimer}` },
  ];
  page({
    path: `/season/${m.slug}/`, hero: m.n <= 2 || m.n >= 11 ? 'valley' : m.n <= 5 ? 'coast' : m.n <= 8 ? 'harbor' : 'bend',
    title: fitTitle(`${m.name} — What's Landing in Oregon`, `${m.name} Seafood`),
    desc: `${m.headline} What's typically landing in ${m.name}: ${land.slice(0, 4).map(s => lc(s.name)).join(', ')}. ${m.markets.slice(0, 60)}`,
    eyebrow: `Month ${m.n} of 12`, h1: `${esc(m.name)} on the Oregon coast`,
    crumbs: crumb([C_HOME, { name: 'Season', url: u('/season/') }, { name: m.name }]),
    answer: `<b>${esc(m.headline)}</b> Typically landing in ${esc(m.name)}: ${land.map(s => esc(s.name.toLowerCase())).join(', ')}. ${esc(m.markets)}`,
    body: `
<section><div class="wrap">
<h2>What's typically landing</h2>
<p>${esc(m.note)}</p>
<div class="grid">${land.map(s => `<a href="${u(`/fish/${s.slug}/`)}"><b>${esc(s.name)}</b><span>${esc(s.flavor)}</span><span class="px">${esc(s.price)}</span></a>`).join('')}</div>
<div class="note"><b>Not a schedule.</b> ${esc(SE.disclaimer)}</div>
</div></section>

<section class="band"><div class="wrap">
<div class="split">
<div><h3>Markets in ${esc(m.name)}</h3><p>${esc(m.markets)}</p></div>
<div><h3>What to cook</h3><p>${esc(m.cook)}</p></div>
</div>
<div class="pull">${esc(m.buy)}</div>
</div></section>

<section><div class="wrap">
<h2>Around ${esc(m.name)}</h2>
<div class="grid">
<a href="${u(`/season/${prev.slug}/`)}"><b>← ${esc(prev.name)}</b><span>${esc(prev.headline)}</span></a>
<a href="${u(`/season/${next.slug}/`)}"><b>${esc(next.name)} →</b><span>${esc(next.headline)}</span></a>
</div>
<h2 style="margin-top:34px">The rest of the year</h2>
<div class="grid">${SE.months.filter(x => x.n !== m.n).map(x => `<a href="${u(`/season/${x.slug}/`)}"><b>${esc(x.name)}</b><span>${esc(x.headline.slice(0, 58))}…</span></a>`).join('')}</div>
</div></section>

<section class="band"><div class="wrap narrow"><h2>Questions about ${esc(m.name)}</h2>
${mq.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div></section>`,
    ld: [breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'Season', url: '/season/' }, { name: m.name }]), faqLD(mq)],
  });
}

/* ===================== ABOUT / CONTACT / FAQ ===================== */
page({
  path: '/about/', hero: 'harbor', tall: true,
  title: fitTitle('About — A Charleston Boat', 'About'),
  desc: `${B.tagline}. A hand-built boat working out of Charleston harbor, an ice hold instead of a freezer, and a store in Springfield open daily.`,
  eyebrow: 'About', h1: 'A boat, an ice hold,<br>and a short drive inland',
  crumbs: crumb([C_HOME, { name: 'About' }]),
  answer: `<b>${esc(NAME)}</b> is ${esc(lc(B.tagline))}. The boat has a <b>${B.facts.vessel_history_years}-year fishing history</b> on the Oregon coast, was <b>hand-built in Charleston</b>, and remains one of the core independent boats in that harbor. The current owner has fished this specific boat for <b>${B.facts.owner_years_on_boat} years</b> and lives up the McKenzie River, as does the rest of the staff.`,
  body: `
<section><div class="wrap narrow">
<h2>The mission, in their words</h2>
<div class="pull">${esc(B.mission)}<cite>— Brandywine Fisheries</cite></div>

<h2>The boat</h2>
<p>${esc(B.facts.vessel_history_claim)} ${esc(B.facts.hand_built)} ${esc(B.facts.harbor)}</p>
<p>${esc(B.facts.owner_claim)}</p>

<h2>The ice hold</h2>
<p>${esc(B.facts.ice_hold)} ${esc(B.facts.never_frozen)} ${esc(B.facts.sushi_grade)}</p>
<p>That trade-off is the whole business. A freezer boat can stay out for weeks; an ice boat cannot, because the clock starts when the fish comes over the rail. Docking more often is the cost of never freezing — and it's why the fish reaches a counter in Springfield, or a market table in Bend, within days.</p>
<p><a href="${u('/guides/ice-fish-holds/')}">More on how an ice hold works →</a></p>

<h2>Bycatch</h2>
<p>${esc(B.facts.bycatch)}</p>
<p><a href="${u('/guides/bycatch-and-gear/')}">More on bycatch and gear types →</a></p>

<h2>Service</h2>
<div class="pull">${esc(B.facts.personal_service)}<cite>— Brandywine Fisheries</cite></div>
</div></section>

<section class="band"><div class="wrap">
<h2>The facts</h2>
<div class="facts">
<div><b>${B.facts.vessel_history_years} years</b>the boat on this coast</div>
<div><b>${B.facts.owner_years_on_boat} years</b>the owner on this boat</div>
<div><b>Charleston, OR</b>hand-built, home port</div>
<div><b>${retail.length} places</b>store plus market days</div>
<div><b>${species.length} species</b>in the case</div>
<div><b>Open daily</b>10am–6pm, Springfield</div>
</div>
</div></section>

<section><div class="wrap narrow">
<h2>About this website</h2>
<p>Every fact on this site comes from one of three places: Brandywine Fisheries' own published material, their published price list, or public fishery-management information from the agencies that set the seasons. Where something is general seafood knowledge rather than a claim about this business, the page says so.</p>
<p>There are no customer reviews or testimonials anywhere on this site, because none were available to verify. There are no photographs of the crew, the boat, the store or any completed work — the imagery here is regional scenery and food texture, and it is labelled as such. Species that are not Oregon fisheries are marked as sourced on every page they appear on.</p>
<p>Seasons, prices and availability all change. The counter at ${esc(PHONE)} is always the authority.</p>
</div></section>`,
  ld: [breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'About' }]), { '@context': 'https://schema.org', '@type': 'AboutPage', name: `About ${NAME}`, description: B.mission, mainEntity: { '@id': abs('/#business') } }],
});

page({
  path: '/contact/', hero: 'oysters',
  title: fitTitle('Contact & Store Hours', 'Contact'),
  desc: `Brandywine Fisheries, ${ST.street}, ${ST.city}, OR ${ST.zip}. Open daily 10am–6pm. Call ${PHONE}.`,
  eyebrow: 'Contact', h1: 'Contact',
  crumbs: crumb([C_HOME, { name: 'Contact' }]),
  answer: `<b>${esc(NAME)}</b> — ${esc(ST.street)}, ${esc(ST.city)}, OR ${esc(ST.zip)}. Open <b>daily 10am–6pm</b>. Phone <b>${esc(PHONE)}</b>. Five market days a week in Eugene, Corvallis, Bend and Portland.`,
  body: `
<section><div class="wrap">
<h2>The store</h2>
<div class="facts"><div><b>${esc(PHONE)}</b>call</div><div><b>${esc(ST.street)}</b>${esc(ST.city)}, OR ${esc(ST.zip)}</div><div><b>${esc(ST.hours)}</b>seven days</div></div>
<p>What's in the case depends on what the boat landed. Calling before you drive is the reliable move — especially for a specific fish.</p>
<h2 style="margin-top:34px">Market days</h2>
<div class="tscroll"><table><tr><th>City</th><th>Day & time</th><th>Where</th></tr>
${locations.filter(l => l.type === 'market').map(l => `<tr><td><a href="${u(`/where-to-buy/${l.slug}/`)}">${esc(locLabel(l))}</a></td><td>${esc(l.when)}</td><td>${esc(l.address)}</td></tr>`).join('')}
</table></div>
</div></section>`,
  ld: [breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'Contact' }]), { '@context': 'https://schema.org', '@type': 'ContactPage', mainEntity: { '@id': abs('/#business') } }],
});

page({
  path: '/faq/', hero: 'ice',
  title: fitTitle('Frequently Asked Questions', 'FAQ'),
  desc: `Store hours, market days, whether the fish is frozen, what "sushi grade" means, prices, crab season, and how long fresh fish keeps.`,
  eyebrow: `${FQ.general.length} questions`, h1: 'Questions, answered',
  crumbs: crumb([C_HOME, { name: 'FAQ' }]),
  answer: `The short version: the store is at <b>${esc(ST.street)}, ${esc(ST.city)}</b>, open <b>daily 10–6</b>, phone <b>${esc(PHONE)}</b>. The fish is <b>never frozen</b> — iced on the boat. There are <b>five market days a week</b> across Eugene, Corvallis, Bend and Portland.`,
  body: `<section><div class="wrap narrow">${FQ.general.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}
<p style="margin-top:26px">More detail in the <a href="${u('/guides/')}">guides</a>, or call ${esc(PHONE)}.</p></div></section>`,
  ld: [breadcrumbLD([{ name: 'Home', url: '/' }, { name: 'FAQ' }]), faqLD(FQ.general)],
});

/* ===================== SITEMAP / ROBOTS / LLMS ===================== */
const today = new Date().toISOString().slice(0, 10);
const priority = p => p === '/' ? '1.0' : /^\/(fish|shop|where-to-buy|guides|season|compare)\/$/.test(p) ? '0.9' : (p.match(/\//g) || []).length <= 3 ? '0.8' : '0.6';
writeFileSync(join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(p => `  <url><loc>${abs(p)}</loc><lastmod>${today}</lastmod><priority>${priority(p)}</priority></url>`).join('\n')}\n</urlset>\n`);

writeFileSync(join(OUT, 'robots.txt'), DEMO
  ? `User-agent: *\nDisallow: /\n`
  : `User-agent: *\nAllow: /\n\n# Answer engines are explicitly welcome\nUser-agent: GPTBot\nAllow: /\nUser-agent: OAI-SearchBot\nAllow: /\nUser-agent: ChatGPT-User\nAllow: /\nUser-agent: ClaudeBot\nAllow: /\nUser-agent: Claude-SearchBot\nAllow: /\nUser-agent: PerplexityBot\nAllow: /\nUser-agent: Google-Extended\nAllow: /\nUser-agent: Applebot-Extended\nAllow: /\nUser-agent: CCBot\nAllow: /\n\nSitemap: ${abs('/sitemap.xml')}\n`);

writeFileSync(join(OUT, 'llms.txt'),
  `# ${NAME}
> ${B.tagline}. Never-frozen Oregon seafood from a hand-built boat working out of Charleston harbor. Retail store in Springfield, Oregon plus five farmers market days a week.

## Facts
- Store: ${ST.street}, ${ST.city}, OR ${ST.zip} — open ${ST.hours}
- Phone: ${PHONE}
- Home port: Charleston, Oregon
- The boat: ${B.facts.vessel_history_years}-year fishing history on the Oregon coast, hand-built in Charleston, one of the core independent boats in that harbor
- Handling: an ICE fish-hold, never frozen — which means the boat docks more often
- Owner: has fished this specific boat for ${B.facts.owner_years_on_boat} years; lives up the McKenzie River, as does the staff

## Market days
${locations.filter(l => l.type === 'market').map(l => `- ${l.city}: ${l.when} — ${l.address}`).join('\n')}

## Species and prices
${species.map(s => `- [${s.name}](${abs(`/fish/${s.slug}/`)}): ${s.price}. ${s.flavor}. Cook to ${s.cook_temp.split(';')[0]}. ${s.oregon_fishery ? `Oregon fishery — ${s.gear.split('—')[0].trim()}.` : 'Sourced, not an Oregon fishery.'}`).join('\n')}

## Product catalogue
${PR.categories.map(c => `- [${c.name}](${abs(`/shop/${c.slug}/`)}): ${c.items.length} items. ${c.own_production ? "Brandywine's own production." : 'Resold goods from other producers.'}`).join('\n')}

## Cooking methods
${methods.map(m => `- [How to ${lc(m.name.replace(/ing$/, ''))} fish](${abs(`/guides/how-to-${m.slug}-fish/`)}): ${m.one_line}`).join('\n')}

## Guides
${GU.guides.map(g => `- [${g.title}](${abs(`/guides/${g.slug}/`)}): ${g.question}`).join('\n')}

## Seasons
${SE.months.map(m => `- [${m.name}](${abs(`/season/${m.slug}/`)}): ${m.headline}`).join('\n')}

## Comparisons
${CM.comparisons.map(c => `- [${bySlug[c.a].name} vs ${bySlug[c.b].name}](${abs(`/compare/${c.a}-vs-${c.b}/`)})`).join('\n')}

## Notes on accuracy
- Commercial fishery seasons are set annually and shift year to year. All season information is typical, not guaranteed.
- Prices are Brandywine's published prices and change.
- Species not landed by the Oregon boat (ahi, swordfish, mahi mahi, large raw shrimp, scallops) are labelled as sourced on every page.
- This site carries no reviews or testimonials, and no photographs of the business, its crew, its boat or its work.
`);

writeFileSync(join(OUT, '.nojekyll'), '');
console.log(`✓ ${urls.length} pages → ${OUT}${DEMO ? '  [DEMO: noindex]' : ''}`);
