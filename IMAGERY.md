# Imagery

Twelve images. Two are real licensed photographs; ten are generated. Every one is
credited on `/credits/`, and the generator renders a credit line over any hero
whose licence requires attribution.

---

## The two real photographs

| File | Subject | Photographer | Licence |
|---|---|---|---|
| `fish-crab.jpg` | Live Oregon Dungeness crab | **Oregon Department of Fish & Wildlife** | CC BY-SA 2.0 |
| `shop-smoked.jpg` | Sides of salmon on racks in a smoking chamber | Juerg Vollmer | CC BY-SA 2.0 |

Both were resized, cropped to 3:2 and colour-graded toward the navy/gold palette.
**Under share-alike those modified versions are themselves CC BY-SA 2.0** — stated
in `data/credits.json` and on the credits page. Attribution here is a licence
condition, not a courtesy; remove the credit and the site is no longer licensed to
show the image.

The crab photograph is the best single image on the site: live Dungeness, shot by
the state agency that actually manages the fishery.

---

## Why the other ten are generated

Roughly 650 free-licensed candidates were reviewed across three sources —
Openverse (CC0), Openverse (CC-BY), and Wikimedia Commons categories — pulled into
contact sheets and curated visually. Two cleared the bar. What the rest looked
like, by slot:

| Slot | What the free-licensed pool actually contained |
|---|---|
| `loc-market` | **Other businesses' storefronts** — "Two Cousins Fish Market", "Hatch's Fish Market", "Katie's Seafood Market" — with legible signage, plus identifiable customers. Putting a competitor's premises on this site would misrepresent it as Brandywine's. Hard reject. |
| `hero-harbor` | Amateur snapshots, one oil painting, and boats from the wrong coast carrying legible names and registration numbers (`COLBY LEE — WINCHESTER BAY OR`). A named third party's vessel under a "our boat" headline is exactly the claim this site must not make. |
| `fish-salmon` | Plated restaurant dinners and fish trimmings in a metal bowl on concrete. |
| `fish-halibut` | Almost entirely 19th-century scientific engravings. |
| `fish-oysters` | White-background specimen cutouts, shot for catalogues. |
| `tex-ice` | Cocktails, ice-cube trays, a conference panel, and a dog. |
| `scene-bend` | Washington Cascades and the Seattle/Bellevue skyline — wrong region. |
| `method-pan`, `scene-valley`, `scene-coast` | Nothing that beat the current frame once graded. |

Also rejected outright wherever it appeared: NOAA/agency specimen photography with
**rulers, catalogue numbers and phone numbers in frame**, and any supermarket case
showing another shop's price cards.

The generated set was produced through Higgsfield (`gpt_image_2`, 3:2) under one
byte-identical style preamble so it reads as one place:

> Editorial documentary photography, natural light, muted coastal palette of deep
> navy, weathered wood, sea-glass green and warm gold, shallow depth of field, film
> grain, no text, no logos, no readable signage, no identifiable faces.

**Known defect:** the API silently defaulted to `1k` resolution and `low` quality
rather than the `2k`/`high` intended, so these are softer than they should be.
Re-running at 2k/high is a one-line change in the batch call — it needs Higgsfield
credits, which the account is currently out of.

---

## The line that does not move

**Never generated, and not present anywhere on this site:** the Brandywine boat,
its crew, the Springfield store, customers, completed orders, before/afters, or
anything a visitor could read as "this is us" or "this is our work."

That is not a stylistic preference. A generated photograph of a storefront or a
crew is a factual claim about a real business, and it is the kind of claim that
gets a seller in trouble with their own customers.

A footer disclosure on all 261 pages states it plainly:

> Photography on this site is regional Oregon scenery and food styling. It is not
> photographs of the Brandywine boat, crew, store or catch.

---

## Replacing these

Brandywine's own photographs beat every option here. Drop them into `assets/img/`
under the same filenames and rebuild. Then:

1. Update the matching `ALT` entry in `gen/build.mjs` — alt text describes the real
   photograph, so it must change with the file.
2. Update or remove that image's entry in `data/credits.json`.
3. For any slot that becomes a genuine Brandywine photograph, the footer disclosure
   should be narrowed so it no longer disclaims an image that *is* theirs.

## Better free sources, if the budget stays at zero

The Unsplash and Pexels licences both allow commercial use with no attribution, and
their food and harbour photography is a different class from anything here. Both
need a free API key; neither exposes a usable unauthenticated search endpoint
(Unsplash's internal `napi` is blocked, Pexels' search page is JS-rendered).
A key takes about two minutes and would replace most of the ten.
