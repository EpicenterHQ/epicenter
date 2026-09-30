# Epicenter homepage design study

`index.html` is a self-contained homepage: inline CSS, inline JS, inline SVG, system fonts, no network requests. Open the file directly in a browser.

## Direction: a press for personal software

Independent software has a lot in common with independent publishing. One person makes a thing, puts their name on it, and hands it to people who care. The page borrows the look of a risograph-printed broadsheet: flat spot inks, visible misregistration, paper grain, heavy condensed type, and colophons instead of feature cards.

The idea carries into the product facts. Apps have a publisher (Braden Wong), a "built on" line (Epicenter), and a place they are headed (a personal domain). A book colophon already has those fields, so each app gets one.

## The graphic idea: the period is the epicenter

The headline's final period is drawn as a pink dot with a blue misregistered shadow. Seismic rings radiate from that dot across the hero, and a dashed axis runs from it to the right edge. Where the axis crosses the labeled rings, tags spell out the model in order of distance: your files (`.md + .sqlite`), Epicenter (in development), apps (Whispering, Vocab), and yours. The diagram explains the architecture without a separate diagram section.

The period stays in the DOM, so the h1's text is exactly "Make software that’s unmistakably yours." JS measures the dot and places the rings, the tags, and the seismogram burst below the hero, so they stay aligned at every width. Tags that would leave the viewport hide themselves.

The top edge of the blue foundation band is a seismograph trace whose spike sits under the dot. The footer ends on an oversized "Epicenter" wordmark bleeding off the page.

## Type

- Display: Avenir Next Condensed at weight 800 (Heavy), tight leading, slight negative tracking. Falls back to Arial Narrow, Roboto Condensed, then system sans.
- Text: Avenir Next, falling back to Segoe UI or system-ui.
- Labels and file contents: `ui-monospace` (SF Mono, Menlo, Consolas).

One family in two widths plus a mono. No serif accents.

## Color

Four riso inks on paper, each with one job:

| Ink | Hex | Role |
| --- | --- | --- |
| Paper | `#f3f2ec` | page and proof sheets |
| Ink | `#111016` | type, rules, hard offset shadows, the Build section |
| Fluorescent pink | `#ff3d9a` | the epicenter, Whispering, footer, overprint |
| Ultramarine | `#2338f0` | the file foundation band, SQLite, overprint |
| Yellow | `#ffd31a` | status chip, Vocab, highlights |

Pink over blue uses `mix-blend-mode: multiply` to produce a violet overprint. Pink never carries small text on paper, because the contrast is too low; it carries shapes or sits behind ink text.

## Page structure

1. Nav: mark and wordmark, section links, a yellow "In development" chip, GitHub. Below 860px the links move into a menu button (Escape closes it).
2. Hero: broadsheet masthead ("Early edition: in development"), the headline, the ring diagram, the supporting line, a status box stating Epicenter and the file foundation are still being built, and two actions: "Read the source on GitHub" and "See the apps".
3. Foundation (blue band): "Everything radiates from your files." A pink "In development" stamp, huge `.md` and `.sqlite` type, and the first illustrative sample.
4. Apps (paper): Whispering and Vocab as staggered covers of different sizes, each followed by a colophon with Publisher, Built on, Today, and Next. "Planned" tags carry a dashed border so planned items never read as shipped.
5. Build (ink): "The next cover has your name on it." A cover maker, then three steps pointing at the real source links.
6. Footer (pink): links, a plain statement of what the page does not do, and the bleeding wordmark.

## Interactions

All state lives in memory and disappears on reload.

- One entry, two files (labeled "Illustrative sample"). Type an expression and the same entry appears as a draft in a Markdown sheet and a SQLite table. "Add entry" commits it with a yellow flash; the sample caps at six entries; "Reset sample" restores the two starting entries. User text goes in through `textContent` only. A note under the panel says it is a sketch of the direction, not a working Epicenter feature.
- Vocab sample card: flips to show the meaning. It is a toggle button with `aria-pressed` and a screen-reader label.
- Whispering cover: on hover the keycaps press and the waveform moves. The cover caption says it is an illustration, not a recording.
- Cover maker (labeled "Illustrative"): app name, one line, publisher, ink, and pattern update a live cover in the same style as the real app covers. "Reset cover" restores the defaults.
- The rings expand once on load. There are no loops or scroll effects. `prefers-reduced-motion` removes every animation and transition and turns off smooth scrolling.

## Honesty rules applied

- "Early" or "in development" appears in the nav chip, masthead, hero status box, ring tag, foundation stamp, Build intro, and footer.
- The file foundation is always described as the plan or direction.
- Whispering: its desktop capabilities run inside the Epicenter host today; standalone personal-domain releases are marked Planned and "Not launched".
- Vocab: runs in the browser today; the personal-domain move is marked Planned.
- No testimonials, metrics, logos, downloads, API docs, sign-in, recording, or network calls. External links go only to the four URLs in the brief.

## Responsive behavior

Layout is a 12-column grid at desktop (1440px target) with gutters scaled from `3.4vw`.

- At 1100px and below: heading copy moves under the headings, the sample stacks its form over the sheets, Whispering spans full width, and the cover maker stacks.
- At 860px and below: the menu button takes over, the file kinds and sheets stack, and the steps become a single column.
- At 560px and below (390px target): the headline drops its second-line indent, the chip hides (the masthead and status box still say "in development"), colophons become single-column, and offset shadows shrink.

The headline scales at `10vw`. Its longest line is about 8.5em, so it fits inside the gutters at every width above the 3.05rem floor. Below that it wraps between words.

## Validation

Command run from the repo root:

```sh
bun design-study/check.ts
```

Result: `OK: 22 links, 35 ids, 305 CSS blocks, 60.4 KB`. The script checks:

- the exact h1 text and the required product copy
- no en or em dashes
- no external scripts, stylesheets, images, fonts, remote `url()`, fetch, network, storage, or media APIs
- every external link is one of the four allowed URLs, and all four are present
- every `#anchor`, `aria-controls`, and `aria-labelledby` resolves to an id, and ids are unique
- the inline script parses
- CSS braces are balanced

## Not verified here

Launching a headless browser was not permitted in this session, so the page has not been rendered or screenshotted. Visual fit (headline line breaks, tag placement, the Whispering row widths between 1100 and 1300px) was reasoned from Avenir Next Condensed glyph widths and needs a rendered check at 1440px and 390px. JS behavior was checked for syntax only, not executed against a DOM.
