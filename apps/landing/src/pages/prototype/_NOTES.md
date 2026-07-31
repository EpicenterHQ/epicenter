# Prototype: local-first manifesto

Throwaway. One route, one direction. Delete or absorb; do not let it rot here.

The leading underscore is what keeps Astro's file router from turning these
notes into a public page at `/prototype/NOTES/`.

Run: `bun dev:landing`, then `http://localhost:4321/prototype/manifesto/`

## The question

Can the landing page lead with the **human** problem (a body of work dispersed
across rented accounts) and carry a manifesto's confidence, without spending a
single unearned claim?

The live index at `e6ed2328d7` already refuses to lie, but it opens as an
explanation. This asks whether an argument can open instead, and whether the
honest parts get weaker or stronger when the page is louder.

## The thesis it argues

Your work outlives every tool that touches it, so the work should be the
permanent thing and the tools should be disposable. One home per person, not one
per app or per device. Applications declare what they understand and read
through that declaration; they own nothing. Leaving is the shape of the thing,
not an export button. Then the proof, at real size, including the part that
hurts.

## What is deliberate

- **Fragmentation first, and human.** The opening is a person's decade, not an
  architecture. The diagram under it is drift, not a table.
- **The one gesture.** Rows keep a horizontal offset at rest, so the diagram is
  complete with motion disabled; the 560ms settle on load only delivers it. No
  scroll triggers anywhere, per the rule in `styles/site.css`.
- **The compromise sits before the ledger.** A local-first manifesto that buries
  its plaintext server has already lost the argument, so "a manifesto that hides
  its server is an advertisement" comes before "what actually runs today".
- **The article is the payload.** "Hello, World" is rendered complete, in all
  three renditions, with its attribution slug. Not a card, not a teaser.
- **`noindex`.** The page reproduces an article that canonicalizes to
  bradenwong.com. It also keeps the route out of the hand-listed sitemap.
- **Facts are borrowed, not invented.** Every claim comes from `lib/site.ts` or
  from the copy already audited on the live index. The four opening diagram rows
  are invented and say so on the page.

## Open questions for the reader

1. Does "You do not have a body of work. You have a dozen accounts." land as
   true, or as an insult to someone who does have one?
2. Is the drift diagram an argument or a decoration? It is the only motion on
   the page and the first thing to cut if it reads as the latter.
3. Is a whole article inside a landing page right, or does the page end twice?
4. The right-aligned numeral rail is the composition. Does it survive a phone,
   where it collapses to a label above each block?

## Verdict

_Not yet given. Fill this in, then either fold the winning parts into
`src/pages/index.astro` and delete `src/pages/prototype/`, or delete the whole
directory._
