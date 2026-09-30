# Epicenter homepage design study: the working drawing

`index.html` is a self-contained homepage. It has inline CSS, inline JS and inline SVG, and uses system fonts only. It makes no network requests and has no build step. Open the file directly in a browser.

## Direction

The page is drawn as a technical drawing set for personal software. Mechanical drafting already has an honest way to show what is built and what is proposed, so the page uses it for Epicenter's status:

| Line | Meaning on this page |
| --- | --- |
| Solid | Exists today, even if early |
| Dashed | Being built (the Markdown and SQLite file foundation) |
| Phantom (long, short, short) | Planned (the personal-domain releases for Whispering and Vocab) |
| Blue pencil | Yours: the visitor's changes and the app they would build |

The legend sits next to the first figure. The same rule runs through the nav status chip, the parts list, the app spec sheets, and the status section. This way the status claims are carried by the visuals as well as the copy. The file foundation is never drawn solid.

Blue is the one accent, and it always means "yours". It's the colour of the revision cloud around the word *yours.* in the headline, the part of your own in the assembly drawing, the revision marks on the bench, and the closing band, where the visitor is invited into the source.

Palette: warm drafting paper (`#eeebe3`), near-black ink, ultramarine (`#2433d6`), and a graphite cutting-mat surface for the bench. Type: the platform's sans (SF on Apple, Segoe UI on Windows), tightly tracked for display. System monospace is used for drafting annotations: figure numbers, balloon numbers, spec labels. There are no web fonts.

The page avoids terminal cosplay: no green phosphor, no fake shell prompts, no scanlines. The only command line is a real `git clone` for the real repository.

## Sheets

1. **Hero and Fig. 1 Assembly.** The exact headline, with a hand-drawn revision cloud and a delta "A" around *yours.* These are computed from the word's live bounding box, so they follow reflow. An isometric exploded drawing shows three layers. At the bottom are your files (dashed), then Epicenter, then Whispering, Vocab and a blue block of your own. A ruler-styled range control explodes or assembles the stack. Numbered balloons tie to a parts list with From and Status columns. Hovering a part or its row cross-hatches both. On load the stack separates, then the blue block is drawn in; that is the page's one storytelling motion.
2. **Fig. 2 The bench** (labelled illustrative). This is the functional centrepiece for "make software your own". On the left is an editable `bread.md`, a small baking log. In the middle, a small app parses it live. On the right are controls to revise the app: its name, view (log, table, plot), visible fields, order, plot axes, and accent. Every app change is logged as a lettered revision with a time. Two tallies show "App revisions" and "bread.md edits". The key moment is the line "3 revisions to the app. bread.md hasn't changed by a single character." Editing the file updates the app and can add fields; for example, `- flour: rye` becomes a new chip. There are empty, error and skipped-entry states for a deleted file, non-numeric plots, and entries missing an axis field. It is framed as a sketch, and the page says Epicenter doesn't ship this bread log. It doesn't use Vocab or Whispering, so no app is credited with file behaviour it doesn't have.
3. **Fig. 3 Built on Epicenter.** These are spec sheets for Whispering and Vocab: publisher, built on, today (solid), planned (phantom). Each has one true link. Whispering has a keycap, waveform and text mechanism you can play; it is labelled as having no microphone, audio or transcription. Vocab has a flip card with sample expressions written for the page.
4. **Fig. 4 Status.** Three bands ruled in solid, dashed and phantom lines list what exists, what's being built, and what's planned.
5. **Fig. 5 Build.** A full-bleed ultramarine band with a copyable clone command and the four true links.
6. **Footer title block.** Project, status, source, and "Revised by: You · N revisions". The count comes from the bench and is kept in memory only.

## Product-fact guardrails

- The file foundation and Epicenter are stated as early or in development in the hero, the nav chip, the parts list, and the status section.
- Whispering: "Press a shortcut. Speak. Get text." Publisher Braden Wong, built on Epicenter. Its desktop capabilities run inside the Epicenter host today; standalone personal-domain releases are marked planned and not launched.
- Vocab: a browser app for practicing expressions, by Braden Wong, built on Epicenter. Its personal-domain move is marked planned.
- The only links are the four supplied URLs and in-page anchors.
- There are no testimonials, metrics, logos, downloads, API docs, recording, authentication, persistence, or network calls. All sample state lives in JS memory and is gone on reload.

## Interaction and accessibility notes

- The nav highlights the current section (scroll spy). Below 960px it collapses into a menu button with `aria-expanded`; Escape closes it.
- The bench uses native radios, checkboxes, a text input and selects, with custom styling and visible focus rings. The textarea has a synced line-number gutter. The revision log and tallies use `aria-live` where changes matter.
- Fig. 1 has a `<title>` and `<desc>`. The parts list is a real table that carries the same information for non-pointer users.
- `prefers-reduced-motion` skips the intro, the draw-ins, the typing and the card flip transitions. Every final state stays visible.
- Layout targets 1440px, with explicit collapses at 1180, 960 and 640px, down to 390px.

## Validation run

- `bun design-study/check.ts` is an offline static check. It checks that the inline script compiles, and that the page uses no network, storage, media or external-resource APIs. It checks that every external link is one of the four supplied URLs, that every in-page anchor resolves, and that there are no duplicate ids. It also checks for no en or em dashes, that the required product copy is present, and for a short list of filler words.
- No browser render was run in this environment; the sandbox blocked headless Chrome. Visual and responsive verification is left to the integrator.
