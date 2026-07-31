# apps/landing/scripts

Local authoring tools. Neither one runs during `astro build`, in CI, or on any
deployment path. The site builds from committed files alone.

## `project-editions.ts`

Projects the Vault editions that the `blog/epicenter.so` outlet currently
carries into committed Markdown under `../src/content/writing/`.

```bash
# Regenerate. VAULT_ROOT defaults to ~/Code/vault.
bun run --cwd apps/landing project:editions

# Fail if the committed projection is stale, missing an article the outlet now
# carries, or still holding one it no longer does.
bun run --cwd apps/landing project:editions -- --check

# Answer from local Vault files instead of asking bradenwong.com what it serves.
bun run --cwd apps/landing project:editions -- --offline
```

`--offline` writes the same bytes an online run writes, images and their
intrinsic dimensions included, so its output is committable and a `--check` in
either mode validates the other's. The one thing it cannot know is deployment,
so it assumes an approved round is live at its canonical address.

### What gets published

Nothing is chosen in this repository. `blog/epicenter.so` is a public web outlet
declared in the Vault's `outlets/`, an active facet declares that outlet in its
`outlets` contract, and an approved edition reaches this site by naming that
facet in its own ordered facet list. Adding or removing an article is an act in
the Vault, followed by a fresh projection here.

A page can be released more than once. Each round is its own edition, and only
the page's newest approved round is published: an older round that named a
member facet has been superseded, and republishing it would put a stale article
beside a canonical page that has moved on. A round that drops the facet
withdraws the article; an unapproved round in flight changes nothing.

The canonical origin is read out of the Vault too, from the single outlet that
declares `canonical_web`, and checked against the address `src/lib/site.ts`
states in the site's own prose. Every projected article canonicalizes there.

### What it is allowed to read

`outlets/` and `facets/` frontmatter, every edition's `article.md` frontmatter,
and the body of a selected edition's `article.md`. Nothing else: no walk over
`pages/`, `journal/`, `productions/`, or review artifacts, and every edition id
is checked against a UUIDv7 pattern before it becomes a path. Media is never
copied. Audio, video, and images are referenced by their public bradenwong.com
URL, and the script verifies each one answers before writing it down.

Re-run it after Braden approves, reapproves, or refacets an edition, then commit
the diff. `--check` is how you notice that you should have.

`project-editions.test.ts` covers the selection rules, including release-again
rounds, against small Vaults written to a temporary directory.

## `og-image.html`

The source of `../public/og-image.png`. Rendered once and committed, because a
build-time renderer would mean shipping a headless browser to draw one static
image.

```bash
cd apps/landing/scripts
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$chrome" --headless --disable-gpu --hide-scrollbars \
  --window-size=1200,900 --screenshot=/tmp/og-tall.png "file://$PWD/og-image.html"
sips -c 630 1200 /tmp/og-tall.png --out ../public/og-image.png
```

The design is a 1200x630 card centred in a 900px page, and the capture is a
centre crop. That indirection is deliberate: Chrome's `--screenshot` clips
content near the bottom of the viewport it was given, so the card is kept away
from that edge and cropped back out afterwards.
