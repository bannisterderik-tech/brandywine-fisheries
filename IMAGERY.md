# Imagery

Twelve images, generated via Higgsfield (`gpt_image_2`, 3:2), converted to
progressive JPEG at 1536px. Total 3.6 MB for the whole site.

A single style preamble was held byte-identical across all twelve so the set reads
as one place rather than twelve stock photos:

> Editorial documentary photography, natural light, muted coastal palette of deep
> navy, weathered wood, sea-glass green and warm gold, shallow depth of field, film
> grain, no text, no logos, no readable signage, no identifiable faces.

## The line

**Generated:** regional Oregon scenery (a working harbor, the coast in fog, the
valley in winter rain, the high desert), food texture (fish on ice, oysters, smoked
salmon on a board, a fillet in a skillet), and abstract texture (flake ice).

**Never generated, and not present anywhere on this site:** the Brandywine boat,
its crew, the Springfield store, customers, completed orders, before/afters, or
anything a visitor could reasonably read as "this is our work" or "this is us."

That line is not a stylistic preference. A generated photo of a storefront or a
crew is a claim about a real business, and it is the kind of claim that gets a
seller in trouble with their own customers.

## Where it's still a risk

The harbor image (`hero-harbor.jpg`) shows unmarked commercial fishing boats. On
`/about/` and the Charleston page it sits next to text about the F/V Brandywine,
and a visitor could take it for their boat. The mitigation is a disclosure in the
footer of all 260 pages:

> Photography on this site is regional Oregon scenery and food styling. It is not
> photographs of the Brandywine boat, crew, store or catch.

This is a mitigation, not a fix. **The real fix is their photographs.** The moment
Brandywine supplies real images of the boat, the harbor, the store and the case,
they replace the generated scenery — drop them into `assets/img/` under the same
filenames and rebuild. The alt text in `gen/build.mjs` (`ALT`) must be updated at
the same time, and the footer disclosure removed for any image that becomes real.

## Files

| File | Subject | Used on |
|---|---|---|
| `hero-harbor.jpg` | Working harbor at first light, fog, crab pots | Home, About, Charleston, season pages |
| `fish-salmon.jpg` | Whole side of salmon on flake ice | Salmon and steelhead pages |
| `fish-halibut.jpg` | Halibut steaks on ice | Whitefish, tuna, compare pages |
| `fish-crab.jpg` | Cooked Dungeness on ice | Shellfish pages, steaming |
| `fish-oysters.jpg` | Oysters on the half shell | Store pages, raw method, contact |
| `shop-smoked.jpg` | Sliced smoked salmon on a board | Smoked shop category, smoking method |
| `method-pan.jpg` | Fillet searing in cast iron | Method pages |
| `loc-market.jpg` | Empty market park block, early morning | Market location pages |
| `scene-coast.jpg` | Coastline in fog, sea stacks | Guides, spring season pages |
| `tex-ice.jpg` | Flake ice macro | Guides hub, FAQ |
| `scene-bend.jpg` | High desert, Cascades | Bend pages, autumn season |
| `scene-valley.jpg` | Valley farmland in winter rain | Season hub, winter months |

The market image is deliberately empty and pre-opening — no vendors, no customers,
no faces, and nothing that reads as Brandywine's own booth.
