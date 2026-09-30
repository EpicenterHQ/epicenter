# Epicenter homepage design study

`index.html` is a self-contained homepage for Epicenter. Open it directly in a
browser; it needs no server, build step, fonts, images, or network access.
`check.ts` runs the offline checks (`bun design-study/check.ts`).

## Direction

Epicenter reads here as a small independent studio that prints its own
broadsheet: warm paper, dark ink, one vermilion accent, and type doing most of
the work. The page is for someone who makes and personalizes software, so it
talks like a workshop, not a sales floor.

The idea comes from the name. The full stop at the end of "yours." is drawn as
a vermilion dot, and the hero's rings radiate from it. Three rings are labeled
on their arcs: your files (Markdown, SQLite), then Epicenter (the foundation,
in development), then apps (Whispering, Vocab, yours). The headline's last
character is the center of the diagram. Once the headline settles, three
ripples leave the dot once and stop; there is no looping motion.

## Typography

One serif carries the voice at every size: Iowan Old Style on Apple devices,
falling back to Palatino Linotype, Palatino, Charter, then Georgia. The
headline is set tight (0.93 leading, negative tracking) with a stepped indent
and an italic last line. Oldstyle figures and ligatures are on throughout.

The sans (Avenir Next, falling back to Segoe UI and system-ui) appears only as
small tracked labels, buttons, and metadata. Monospace appears only where files
appear. The rule is: serif speaks, sans labels, mono is a file.

## Composition

- Hero: the headline runs full width; the lede sits beside the short last line
  instead of under it, and the lower-left field belongs to the ring diagram.
  Ring labels slide around their rings in script so they stay between the page
  margin and the copy at any desktop width.
- Chapters i to iii carry a sticky italic folio in the left margin, like a
  running head. Principles hang their roman numerals into the gutter.
- The foundation section pairs principles with an illustrative folder
  specimen (tabs: two Markdown notes and one SQLite table). It is captioned as
  a sketch, not a file format.
- Whispering switches to a full-bleed night band. Its three sentences step
  down and right like a staircase. The sample is a large physical keycap
  labeled "your shortcut."
- Vocab returns to paper with a stack of ruled index cards; the front card is
  a small practice deck.
- The third slot is an empty dashed ring labeled "reserved for something you
  make," which answers "or build your own" without inventing a product.
- A status ledger separates Today from Planned, so every claim on the page has
  one place where its status is stated.
- The footer closes with the wordmark fitted to the full measure and cropped
  at the baseline.

## Honesty constraints

- A persistent notice under the navigation and a pill in the hero state that
  Epicenter is early and the file foundation is still being built.
- Whispering: desktop capabilities run inside the Epicenter host today;
  standalone personal-domain releases are marked planned and not launched.
- Vocab: browser app today; the personal-domain move is marked planned.
- Both samples are labeled "Illustrative sample." Whispering uses no
  microphone; its text is pre-written and says so in a live region. The Vocab
  deck lives in memory and says that nothing is saved.
- No testimonials, metrics, logos, downloads, API docs, or claims of live AI or
  file capability. The only external links are the four supplied URLs.

## Interaction and accessibility

- Mobile menu: disclosure button with `aria-expanded`, closes on link, outside
  click, or Escape.
- Folder specimen: ARIA tabs with arrow, Home, and End keys.
- Whispering: idle, listening, transcribing, and done states, with status text
  in an `aria-live` region; the key is inert while text is being placed.
- Vocab: show meaning, got it, again later, and an end-of-deck reshuffle; focus
  moves to the next action after each step.
- Skip link, visible focus rings, one `h1`, labeled regions, and a `caption`
  on the ledger table. On narrow screens the ledger becomes stacked rows with
  inline column labels.
- `prefers-reduced-motion` removes entry motion, ripples, the caret blink, the
  animated waveform, and typing.

## Responsive behavior

Designed at 1440px on a 12-column grid. Below 1100px the demos move under
their text. Below 860px the grid drops to six columns, the hero copy moves
under the headline, ring labels are hidden, and folios become inline. Below
760px navigation collapses into the menu. Below 560px the ledger stacks and the
specimen's file list becomes a row of tabs. Checked by reasoning down to 390px;
see limits.

## Validation

`bun design-study/check.ts` checks:

- unique ids, and every `aria-*` reference and in-page anchor resolves;
- every external link is one of the four supplied URLs, and each is used;
- no fetched resources: no `src`, `link`, `@import`, remote `url()`, or network
  APIs in the script;
- no microphone, storage, or cookie APIs;
- required product copy is present;
- no en or em dashes, AI filler words, or metric- and testimonial-like copy;
- the inline script parses.

## Limits

- Browser rendering was not available in the environment that produced this
  page, so layout at 1440px and 390px was reasoned from the CSS rather than
  seen. Ring label placement, headline measure with fallback serifs, and the
  hero copy's overlap with the second headline line are the places to check
  first when rendering.
- Font metrics differ across platforms. Iowan Old Style is the intended face;
  Windows falls back to Palatino Linotype, others to Georgia.
- The folder specimen and both samples are illustrations. None of them reflect
  real file formats or the real app interfaces.
