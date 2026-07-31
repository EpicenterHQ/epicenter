# apps/landing/scripts

Local authoring tools. Neither one runs during `astro build`, in CI, or on any
deployment path. The site builds from committed files alone.

## `project-editions.ts`

Projects the approved Vault editions named in `../syndication.json` into
committed Markdown under `../src/content/writing/`.

```bash
# Regenerate. VAULT_ROOT defaults to ~/Code/vault.
bun run --cwd apps/landing project:editions

# Fail if the committed projection has drifted from the Vault.
bun run --cwd apps/landing project:editions -- --check

# Trust local Vault files instead of asking bradenwong.com what it serves.
bun run --cwd apps/landing project:editions -- --offline
```

The allowlist is the whole safety mechanism: the script reads exactly the
edition folders it names and refuses every other path, so no private page,
production, or unapproved draft can reach a public build. Media is never
copied. Audio, video, and images are referenced by their public bradenwong.com
URL, and the script verifies each one answers before writing it down.

Re-run it after Braden reapproves an edition, then commit the diff. `--check`
is how you notice that you should have.

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
