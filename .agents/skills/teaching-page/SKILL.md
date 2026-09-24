---
name: teaching-page
description: Design a self-contained HTML page that teaches one thing, using space and a single accent instead of boxes and colour. Use when building an explainer, lesson, diagram, or walkthrough page, or when an existing page reads dense, overwhelming, or over-decorated. Not for authored Vault pages, which belong to page-writing, and not for a dialectic turn asking for a judgment.
---

# Teaching Page

A page that teaches is elegant when almost nothing on it is asking for
attention. Everything here follows from one idea.

## Contrast is a budget

Borders, colours, weights and sizes all spend contrast to say *this is
different*. Most pages overspend: every card gets a border, every series gets a
colour, every heading gets a size. Nothing stands out, and the reader
experiences that as density.

Spend almost nothing on structure. Then the little you do spend lands, and the
page can direct attention instead of competing for it.

Every rule below is an application of that. When a case is not covered, ask what
the addition buys and what it spends.

## Knowledge or skill

Decide which the page is for, because the two want opposite difficulty.

**Knowledge** is understanding something. Here difficulty is the enemy: it eats
the working memory the reader needs to follow you. Make it as easy as it can
honestly be.

**Skill** is being able to do it later, unaided. Here difficulty is the tool.
Recalling something is what makes it stick, so a page teaching a skill should
make the reader retrieve, predict, or attempt before it shows the answer.

Most pages are knowledge pages and should be easy. A page that feels effortful
without being a skill page is just badly made.

## The three rules

**No boxes.** Space and hairlines, never borders. A box tells the eye where to
stop, which is what makes a page read fast and feel crowded. One exception: a
figure may sit in white, one per page.

**One accent, marking one thing.** Per page and per figure. Everything else is
one neutral grey, plus a lighter tone when a remainder needs to be distinct.
The limit is on what the accent *means*, not how often it appears.

**One idea per section, with real space.** Roughly 50px of air between sections,
and type large enough to slow the reader down. Once the borders are gone, space
is the only separator left, so it has to be generous enough to work.

Everything else is a choice: the measure, whether there is a margin, serif or
sans, how fast it moves. A narrow reading column and a full-width landing page
both satisfy the three rules. Make the choice once and hold it.

## One stylesheet

A standalone page inlines its CSS and stays portable. Pages maintained and
distributed together as a family share `page.css` so their visual language
stays consistent. Sharing a folder alone does not make unrelated artifacts a
family; choose the stylesheet boundary from how the pages will be used.

The tokens, copied verbatim rather than re-derived as near-neighbours:

```css
--paper:  #faf7f0;   /* the page                        */
--ink:    #1a1714;   /* headings                        */
--body:   #3a352e;   /* prose                           */
--quiet:  #8b8478;   /* captions, labels, margin notes  */
--rule:   #e6dfd0;   /* hairlines between sections      */
--line:   #cec5b2;   /* neutral marks inside figures    */
--accent: #a8501f;   /* the one thing                   */
```

Body text 18px, line-height 1.7, serif. Sans only for the small things: kickers,
margin notes, figure labels. At landing measure, scale headings up and leave the
body alone.

## Choose the shape before writing

The shape is a claim about the content. Pick it deliberately.

- **Ladder** — full-width numbered bands. When the order *is* the lesson.
- **Margin notes** — one column, asides beside it. When it is an argument.
- **Annotated drawing** — one picture held still, numbered notes beside it. When
  the thing has a physical or spatial form.
- **Rail** — a line where position means elapsed time. When order is causal.
- **Table** — the table as the whole document, hairlines only. When it is a real
  comparison and the reader will scan a column.
- **Sheet** — equal tiles, no reading order. When they will come back and look
  one thing up.

The split that decides it: **a page read once, or a page returned to.** The
first four are read start to finish and then rarely again, so they can be slow
and can carry an argument. Table and sheet are looked up repeatedly, so they are
denser by nature and cost more of the budget. Ladder and margin notes are the
defaults; reach for the last two only when the content really is a comparison or
a lookup.

## Draw the figure

Never use colour for categories. Weight, dash, size and position carry them, and
they leave the accent free.

- **Ranked bars** — order matters, values secondary. Accent the row to act on;
  every other bar one grey, because they are the same quantity at different
  sizes.
- **Two lines over time** — baseline thin and grey, the argued line thicker and
  accented. That replaces the legend.
- **Sequence on a rule** — space the stops by how long each takes. Evenly spaced
  steps quietly assert they cost the same.
- **Nesting** — indent plus a vertical rule. Stays legible past three deep,
  where nested boxes stop working.
- **Part to whole** — one divided bar, not a pie, with the accented segment
  being the one that can change.
- **Two axes** — axes only, no quadrant fills or labelled boxes.
- **Before and after** — identical axes and scale; dashed grey for the old
  state, solid accent for the new.
- **Hierarchy** — elbows and indent. Branches not under discussion drop to grey.

Label directly on the mark. A legend is a second lookup the reader has to
perform, and direct labels are almost always possible.

## Write it

Open with the promise: one sentence saying what the reader gets, before any
evidence. Then earn it.

Put anything skippable in the margin — caveats, sources, tangents. Test by
deleting every note: if the argument still holds, they were placed correctly; if
it breaks, they were never notes and belong in the column.

Keep sections to one idea. A section needing two headings is two sections. Keep
the whole page to one win the reader can walk away with; working memory is small
and a second win is a second page.

Say who it is for and what they are assumed to know already, in the opening. A
page pitched at the wrong distance fails for reasons the layout cannot fix.

**Do not teach from memory.** Check the claims, and name the single best source
at the end so the reader can go past you. Where a specific number or finding
carries weight, link it. A page with no sources is asking to be trusted on
nothing.

End on the shape the content has. How-to material ends by naming the single
thing to do. An explanation may end on a reflection, and forcing an action onto
it is worse than letting it close.

## What breaks it

Boxed cards, tiles and panels. A second accent. Colour-coded categories. Legends.
Badges, testimonials, calls to action, and anything else borrowed from a landing
page whose job is to look settled. Evenly spaced flow steps. Four tinted
quadrants. Invented precision in a figure when the honest claim is only the
order — say so in the caption and use qualitative marks.

## Before you finish

Write to an ignored scratch path, with inline SVG, no CDN, and no build step.
Inline CSS for a standalone page; use the shared `page.css` for a page family
as described above. Open it, then screenshot it and look, because these failures
are visual and do not appear in the source.

Three checks: nothing is in a box; the accent appears in exactly one role; a
reader could stop after any section without losing the thread.

## References

[references/example-page.html](references/example-page.html) is the default
shape at reading measure — ladder, margin notes, one figure.
[references/example-landing.html](references/example-landing.html) is the same
three rules at landing measure, proving the measure is a choice.
[references/figures.html](references/figures.html) draws the eight figure types
with a note on the job each does.
