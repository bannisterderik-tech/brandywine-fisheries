# Adversarial review log — Brandywine Fisheries

Reviewed against the five site-factory rubrics (Owner, Google, Copy Cop, Customer,
Engineer). Every fix went into `data/` or `gen/build.mjs` and the site was rebuilt —
no generated page was ever hand-patched.

---

## Round 1

### BLOCKER — Copy Cop — mangled sentences from field concatenation
Two templates joined a "headline — aside" field into a larger sentence and produced
garbage on every species page and every location×species page:

> "Firm and dense with a large flake; the steak of white fish, very lean — among the
> leanest fish in the case fat."

**Fix:** added `head()`, which takes only the headline clause before the first
em-dash/semicolon/paren, and restructured the affected sentences into labelled
`Flavor. / Texture. / Fat.` runs where the full field reads better whole.
*Affected: 100 species + method pages, 58 location×species pages.*

### BLOCKER — Copy Cop — proper nouns flattened by `.toLowerCase()`
87 call sites lowercased names for mid-sentence use, producing "pacific halibut",
"chinook salmon", "bend runs wednesdays". At this page count that is thousands of
instances.

**Fix:** `lc()` — splits on a proper-noun regex with a capture group and lowercases
only the non-matching segments. Later split into `lc()` (short names) and `lcFirst()`
(multi-sentence fields), because running whole paragraphs through `lc()` lowercased
the start of every following sentence and flattened organisation names
("the international pacific halibut commission").

### MAJOR — Google — 11 duplicate titles
The two Eugene market days (Saturday and Tuesday) share a city, so every
`<species> in Eugene, OR` title collided, plus the two location hub pages.

**Fix:** `locLabel()` disambiguates any city with more than one location by
appending the day — "Eugene Saturday", "Eugene Tuesday". Applied to titles, H1s,
breadcrumbs and every internal link label. *249 → 260 unique titles.*

### MAJOR — Engineer — 48 broken internal links
Species pages linked to `/where-to-buy/<location>/<species>/` for all 20 species,
but those pages are only generated for the 11-species core list, and oysters are
store-only. Nine species linked to pages that were never generated.

**Fix:** `hasLocPage()` is now the single source of truth, used by both the
generator and every linking template. Species with no location pages get the
location hub links instead, with an honest line explaining why
("moves in and out of the case with the season and the landing").

### MAJOR — Google — meta descriptions up to 257 characters
39 pages exceeded the ~155-character truncation point.

**Fix:** `clamp()` applied inside `page()` so it cannot be forgotten — truncates at
a word boundary rather than letting the SERP cut mid-word.

---

## Round 2

### MAJOR — Google — sibling location pages insufficiently differentiated
`Halibut in Bend` and `Halibut in Corvallis` differed only by name, address and
hours. That is the doorway-page pattern regardless of intent.

**Fix:** derived angles. Each location×species page computes real facts about
*that* pairing — market duration in hours, whether this fish is the dearest or
cheapest item at that location, whether the market season and the fishery season
both have to line up, the drive distance against the species' own keeping time —
and renders the two that apply. Nothing is invented; every angle is arithmetic on
data already on the page. Pages that share no applicable angle get different ones.

### MAJOR — Owner — hero image could be read as "our boat"
The harbor image shows unmarked commercial boats. On the About and Charleston pages
a visitor could reasonably take it for the F/V Brandywine.

**Fix:** a sitewide footer disclosure on all 260 pages: *"Photography on this site is
regional Oregon scenery and food styling. It is not photographs of the Brandywine
boat, crew, store or catch."* Plus an explicit paragraph on `/about/`.

### MINOR — Customer — page opened by saying the same thing twice
The hero sub-line and the answer block both rendered the meta description.

**Fix:** `sub` parameter on `page()`; the three highest-volume templates now give
the hero its own short spec line (`$38.95 / lb · Very lean · cook to 130–135°F`).

### MINOR — Copy Cop — redundant alias
"Pacific Halibut (Halibut)" and "also called halibut".

**Fix:** the alias is suppressed when it is a substring of the name.

---

## Round 3 — clean

`node gen/verify.mjs`: **260 pages, 260 unique titles, 260 unique descriptions,
0 errors, 0 warnings.**

Checked and passing:
- sitemap ↔ filesystem parity, both directions (no ghosts, no omissions)
- zero broken internal links, zero orphan pages
- every page: one `<h1>`, unique canonical, unique title, unique description
- every `<img>` carries descriptive alt text
- every JSON-LD block parses

Fabrication scan — all zero: founder name, founding year, "years in business",
star ratings, testimonials, awards, "voted", "best in Oregon".
NAP consistent across all 260 pages; no second phone number anywhere.

---

## Standing notes for the owner

Things deliberately **left off** the site because their own site does not state them:

- **Founder's name.** Third-party sources (LinkedIn, Daily Emerald) name a
  Captain Bill Whitlock. brandywinefisheries.com does not. Not published — naming
  a real person needs their confirmation.
- **Founding year.** Third-party sources say 2010. Their site does not say. Not published.
- **The Roseburg location.** Yelp lists a Brandywine at 1771 W Harvard Ave, Roseburg.
  Their own site lists only Springfield. Not published as a location.
- **"Up to 13 farmers markets a week."** A third-party article says this; their own
  markets page lists four. Only the four they publish are used.
- **Reviews.** None appear anywhere, because none were available to verify.

Each of these would strengthen the site. All five need a yes from the owner first.

**Also needs owner input:** the store's exact map pin (the geo coordinates in
`data/business.json` are approximate for the Main St address block), an email
address (their site uses a contact form with no published address), and real
photographs — which would replace the generated scenery immediately.
