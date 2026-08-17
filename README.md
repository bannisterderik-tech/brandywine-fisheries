# Brandywine Fisheries — 260-page SEO/AEO site

Static site generated from `data/*.json`. No CMS, no build dependencies, no runtime
JavaScript. Deploys as a GitHub Pages project site.

```bash
node gen/build.mjs          # production build  (indexable)
node gen/build.mjs --demo   # demo build        (noindex + robots Disallow)
node gen/verify.mjs         # local audit — exits non-zero on any error
```

## What's here

| Section | Pages | What each one carries |
|---|---|---|
| `/fish/<species>/` | 20 | Price, season, gear, fat, texture, cook temperature, portion, buying and storage |
| `/fish/<species>/<method>/` | 80 | That fish by that method — real heat, timing, pull temperature, the common mistake |
| `/where-to-buy/<location>/` | 7 | Store, five market days, and the home port |
| `/where-to-buy/<location>/<species>/` | 58 | Real market day, address, price, and derived angles specific to that pairing |
| `/guides/` | 42 | 34 buying/handling guides + 8 cooking methods in depth |
| `/compare/<a>-vs-<b>/` | 24 | Spec tables built from the species data, so they cannot drift |
| `/season/<month>/` | 12 | What's typically landing, which markets run, what to cook |
| `/shop/<category>/` | 6 | The real catalogue with real published prices |
| Hubs + about/contact/faq | 11 | |
| **Total** | **260** | |

## The two rules this build enforces

**1. No AI-written prose.** Every sentence is assembled from a fact in `data/`.
There is no paragraph-generation step anywhere in `gen/build.mjs`. Where sibling
pages need to differ, they select between hand-written framings keyed by a hash of
the slug, or render angles *derived arithmetically* from their own data — so two
pages differ because they were given different true things to say.

**2. Nothing invented about the business.** Every business fact traces to
brandywinefisheries.com, their published price list, or public fishery-management
information. See `REVIEW-LOG.md` for the list of things deliberately left off
because their own site does not state them.

## SEO / AEO

- Unique title, meta description, canonical and OG image on every page
- `SeafoodStore` schema with real NAP, geo, opening hours and offers, sitewide
- Per-page `BreadcrumbList`, `FAQPage`, `Product` + `Offer`, `HowTo`, `ItemList`,
  `Article`, `OfferCatalog`, `Event` (market days with `Schedule`)
- A direct-answer block in the first 120 words of every page — the unit answer
  engines actually quote
- `llms.txt` with the full structure, prices, seasons and accuracy caveats
- `robots.txt` explicitly welcomes GPTBot, ClaudeBot, PerplexityBot,
  OAI-SearchBot, Google-Extended, Applebot-Extended and CCBot
- Sitemap with per-section priority
- ~26 KB per page, zero external requests, zero runtime JS, all CSS inlined

## Editing

Change `data/*.json` and rebuild. Never edit a generated `index.html` — the next
build overwrites it. Adding a species to `data/species.json` generates its page,
its method pages, its location pages and its links automatically.

To add the fixes waiting on owner confirmation, see the standing notes at the
bottom of `REVIEW-LOG.md`.

## Going live on brandywinefisheries.com

1. `node gen/build.mjs` (without `--demo`) — clears noindex, opens robots.txt
2. Set `site` in `data/business.json` to `https://brandywinefisheries.com`
3. Rebuild so canonicals, OG URLs, sitemap and llms.txt all point at the real domain
4. Add a `CNAME` file, point DNS, submit the sitemap in Search Console
