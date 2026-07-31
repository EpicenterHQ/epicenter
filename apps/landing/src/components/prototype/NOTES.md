# Prototype: Living Workbench

Throwaway. Delete this folder and `src/pages/prototype/` once the question below
has an answer.

- **Route:** `/prototype/living-workbench/`
- **Baseline:** `e6ed2328d7`
- **Files:** `src/pages/prototype/living-workbench.astro`, `src/components/prototype/Workbench.astro`

## The question

Can the front page **demonstrate** the thesis instead of asserting it?

The shipping homepage argues in paragraphs: your work is scattered, apps should
be replaceable, data should persist. All true, all told. This prototype tries to
make a stranger arrive at the same conclusion by watching one real body of work
be read four ways, with the thing that identifies it never moving.

## The bet

The device is deliberately on a different axis from `Renditions.astro`. That
switch offers Read / Listen / Watch, which are three **output forms** of one
work. The workbench offers Read / Fields / Renditions / History, which are four
**readings of one stored record**. Adjacency is the point: a reader who meets
the workbench on the homepage and the rendition switch on the article page
should feel the same hand, not the same control.

The whole argument is carried by one piece of layout. The title and the edition
identifier sit in a header outside every panel, so switching views cannot
redraw them. They are literally the same two nodes before and after, not a
re-render that happens to agree. If the direction works, that stillness is what
a reader notices, and it costs nothing to make true.

## What is real

Everything in the frame is read out of `src/content/writing/hello-world.md` at
build time: title, subtitle, dates, tags, canonical URL, edition identifier,
the opening paragraphs, and the narration and video addresses. Nothing is a
second copy that could drift from the article it describes. The article is two
clicks away on the same site, so a skeptical reader can check the frame against
the thing it claims to be showing.

Two things in the frame are not read from the record, and both say so where
they appear: the five-row scatter figure in move 1, labelled "Illustration, not
a screenshot", and the pair of contract names in the History selection row,
which the panel and the frame's footer both call out as the exception.

## Known couplings, if this gets promoted

- The History panel's selection row hardcodes two names from the publishing
  contract, `builds-epicenter` and `blog/epicenter.so`, as `SELECTION` in
  `Workbench.astro`. They cannot be read from the record: the projection drops
  facet membership on purpose, because which facets an edition names is a fact
  about the archive rather than a property of the article. So the row states
  them and labels itself as the frame's one exception. If the facet carrying
  this outlet ever changes, that row goes quietly false, which is the strongest
  argument for deleting this prototype rather than promoting it as-is. Anything
  that ships needs the projection to write the origin facet into the frontmatter
  first.
- `Workbench.astro` slices the opening out of `article.body` with a regex rather
  than the Markdown renderer. Fine for a prototype against one known file;
  rewrite it through `render()` before anything ships.
- `min-height: 24rem` on `.panels` keeps the page from jumping between a long
  view and a short one. It is tuned to the current four panels by eye.

## Verdict

_Unanswered. Fill this in, then delete the prototype._
