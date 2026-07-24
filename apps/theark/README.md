# The Ark public delivery plane

`theark` is the Worker behind `https://theark.so`. It serves exactly two kinds
of content:

1. **Fixed deploy-time design assets** from Workers Static Assets (`public/`):
   the one constrained reading theme (`/assets/theark.css`), the favicon, and
   the home and not-found shells. Changing the theme is a redeploy of this
   Worker.
2. **Rebuildable public artifact projections** streamed from the
   `theark-projections` R2 bucket (EU jurisdiction). The publishing side (the
   Vault) writes projection objects; a publication appears by writing R2 keys,
   never by redeploying this Worker.

The artifact and projection semantics (frozen expressions, truthful
permalinks, one constrained theme, insert identity) are owned by the Vault's
publishing ADRs, notably ADR-0059 and ADR-0064 in that repo. This app owns
only hosted delivery; see `docs/adr/0176-the-ark-public-plane-is-a-plain-worker-streaming-eu-r2-projections.md`.

## URL and key contract

Canonical artifact permalinks are `https://theark.so/braden/<artifact-slug>`.

| URL | Serves |
| --- | --- |
| `/` | `public/home.html` (deploy-time shell) |
| `/assets/theark.css`, `/favicon.svg` | Static Assets, literal paths |
| `/<identity>` | R2 `<identity>/index.html`, as a person route |
| `/<identity>/<slug-or-facet>` | R2 `<identity>/<slug-or-facet>/index.html`, as an artifact permalink or facet route |
| `/<identity>/<artifact-slug>/<file>` | R2 `<identity>/<artifact-slug>/<file>`, where `<file>` is exactly `video.mp4`, `narration.mp3`, or `cover.png` |

A human-readable page route has one or two lowercase-hyphenated segments. An
artifact's generated files live directly beneath its permanent permalink, so
the public URL tree and R2 tree say the same thing. The third segment is the
closed generated-media vocabulary; no other filename resolves, so even a stray
bucket object outside that set is publicly unroutable. Because the canonical
page URL is slashless, generated HTML must use root-absolute media URLs such as
`/braden/<slug>/video.mp4`; a bare `video.mp4` would resolve outside the artifact
subtree. Explicit `index.html` aliases, percent-encoded aliases, the reserved
`/assets` identity, and anything outside these exact families are 404 before R2
is consulted. Trailing slashes 308-redirect to the slashless form. Only GET and
HEAD are allowed. Cloudflare Workers Caching owns byte-range delivery from the
Worker's full streamed responses; conditional reads and HEAD remain Worker/R2
behavior.

Delivery policy is Worker-owned: every projection is served with
`cache-control: public, max-age=300, must-revalidate` (bytes at a key are
regenerable, so nothing is `immutable`), and missing objects are `no-store`
so a new publication is visible immediately. The Worker also applies a CSP that
refuses executable per-artifact code while allowing the shared stylesheet,
images, fonts, and media.

The second path segment is one shared publisher-owned namespace: a facet and an
artifact cannot both own `/braden/codes`. The publisher kernel (below) refuses
cross-owner collisions, reserves a route forever to its first artifact owner,
writes media first, and activates `index.html` last. The delivery Worker
deliberately has no route registry.

This Worker deliberately has **no** auth, billing, Postgres, Durable Objects,
Epicenter blob-store access, write routes, or renderer plugins.

## Publishing side: renderer and kernel

The trusted publishing code lives beside the delivery Worker as library
modules the Worker entry never imports, so the deployed public plane keeps
zero write paths (see the ADR-0176 amendment):

- `src/render.ts` is the constrained renderer: one pure function from a
  frozen-artifact-shaped input to one complete semantic HTML document. It
  emits no JavaScript and references only `/assets/theark.css` plus
  root-absolute sibling media. The page title is the frozen body's own lead
  `# Title` heading (Vault ADR-0059: the lead H1 becomes the web title),
  consumed as plain text and never duplicated into the article, so a mutable
  page-row title can never leak into a frozen page. Below the lead title the
  renderer is total: everything outside its explicit Markdown subset (raw
  HTML, executable URL schemes, tables, deeper headings, foreign images)
  renders as visibly escaped literal text, never a throw, because Publish
  freezes before it projects and HTML is disposable. The one throw is a
  missing lead title, which asserts a violated freeze-gate contract.
- `src/publish.ts` is the publisher kernel: given an injected R2-shaped
  object store, it atomically reserves the `<identity>/<slug>` subtree with a
  publicly-unroutable `.artifact` ownership marker via create-if-absent (R2
  `onlyIf: { etagDoesNotMatch: '*' }`), so two racing publishers cannot both
  win. The marker records the private artifact id plus the immutable
  expression digest (Vault ADR-0064; never `integrity_digest`) and the first
  declared publication date. Only an exact identity/expression match
  converges; another artifact is refused the slug forever, and the same
  artifact with a different frozen expression is refused because a permalink
  never changes its words. A retry receives the first reserved date rather
  than rewriting history. Generated HTML and media are not hashed, so theme
  and output rebuilds stay free. It writes generated media
  (`video.mp4`/`narration.mp3`/`cover.png`, the complete media vocabulary the
  reader also enforces) before activating `index.html` last. A store `put` is
  a checked durable write by contract (the adapter has R2 verify a content
  checksum server-side); the kernel never re-downloads objects to prove its
  own writes, and end-to-end proof is the caller's public-URL verification.
  Keys are derived through the delivery Worker's own `resolveProjection`, so
  the kernel cannot write an address the Worker would refuse to serve.

The kernel runs wherever an authenticated caller holds bucket credentials: an
operator CLI first, the Vault's injected `ArkPublisher` port behind it. The
caller supplies a proposed `publishedOn` and the `expressionDigest`, owns
public-URL verification against the expected canonical URL, and records the
kernel's returned authoritative date on the receipt. An exact retry may return
an earlier date already preserved by the route reservation.

The paired Vault publishing change owns the two cross-repository inputs this
kernel requires:

1. The freeze gate must validate that an artifact frozen with a canonical
   Ark slug has a body opening with exactly one lead `# Title` heading
   (ADR-0059 already states the lead H1 becomes the web title; nothing
   enforces it at freeze).
2. `artifactExpressionDigest` mints the immutable
   expression-and-production-input digest ADR-0064 specifies and
   `ArkProjection` carries it, together with the proposed publication date.

The remaining seam is a credential-holding adapter from that Vault port to
this kernel and its public-URL verification.

## Develop

```bash
bun run --cwd apps/theark test        # fetch-handler tests (bun test)
bun run --cwd apps/theark typecheck
bun run --cwd apps/theark typegen     # regenerate worker-configuration.d.ts after wrangler.jsonc changes
bun dev:theark                        # wrangler dev (see note below)
```

## Deploy

The one-time infrastructure prerequisites are an EU-jurisdiction
`theark-projections` bucket and an active Cloudflare zone for `theark.so`.
Jurisdiction is permanent once the bucket is created. `wrangler.jsonc` owns the
canonical custom domain, R2 binding, fixed asset bundle, and Worker deployment:

```bash
bun run --cwd apps/theark deploy
```
