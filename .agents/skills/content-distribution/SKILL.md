---
name: content-distribution
description: Turn one real idea, vault page, article, photo, screenshot, code diff, spec excerpt, or diagram into platform-native content for LinkedIn, X, Reddit, TikTok, Instagram Reels, YouTube Shorts, Medium, Substack, or a personal-site article. Use when creating or editing files in variants/, choosing a channel or platform for a page, republishing or updating content that already shipped, or figuring out what's currently live for a given page.
---

# Content Distribution

Follow [writing-voice](../writing-voice/SKILL.md) for tone. Use [social-media](../social-media/SKILL.md) when drafting final LinkedIn, X, or Reddit post copy.

## Core Philosophy

The goal is not to become a full-time creator. The goal is to make existing
thinking travel farther **without distorting it**.

The page owns the thought. A variant is that same thought *rendered* on one
surface — in the page's own words, order, and voice **by default**. Fidelity is
the default; compression and promotion are opt-in moves the author requests, not
the reflex an agent reaches for. Use one markdown source and real artifacts. AI
casts the page for each surface — chooses what is spoken vs. shown, splits for
timing, re-houses the prose — it does **not** rewrite the argument or pretend to
be the author.

```txt
real idea
  -> pages/<slug>.md (the source thought)
  -> variants/<slug>-<channel>-<format>-<version>.md (one surface's rendering)
       placements: [{platform, published_at, url, caption}] (shipped facts)
  -> performance notes
  -> next ideas from replies
```

### Fidelity ladder

Fidelity is set by **format**; channel is a voice/kit overlay on top.

- **article** (personal-blog / medium / substack / newsletter): near 1:1. The
  variant is the page's prose, lightly re-housed — a channel `subtitle`/dek, house
  styling. Compression is opt-in only.
- **short-video** (instagram / tiktok / youtube): a faithful full performance of
  **one page** — same spine, claims, order, voice. A short-video maps 1:1 to a
  page (ADR-0021). If a page won't fit one reel, **split the page** into smaller
  backlinked pages that each map to their own reel — do not carve a span out of a
  page, and accept that a large synthesis page may have no short-video at all.
- **social-post** (x / linkedin / reddit): the one format that extracts a sharper
  atom, because the surface can't hold a full essay — but preserve the source
  pressure and the real example. Promote, tease, or summarize only when explicitly
  asked.

## Default Workflow

1. Identify the source: a `pages/` note is the default; a photo, screenshot, code
   diff, diagram, spec excerpt, voice note, or product decision can seed a page first.
2. Choose the format and channel (see the fidelity ladder above and the routing specs).
3. Render faithfully by format:
   - **article** — re-house the page's prose; add only a channel `subtitle`.
   - **short-video** — perform the page: lift its prose verbatim as spoken lines,
     insert headings to pace, stage real artifacts before the prose they
     illustrate. See references/platform-renderers.md and ADR-0021.
   - **social-post** — extract the sharpest atom that still carries the source
     pressure; segment into a thread if needed.
4. Preserve the thesis, the order, and the concrete examples. Do not invent hooks,
   lessons, metrics, or CTAs the page doesn't have.
5. Keep performance notes simple: hook (if any), visual type, platform, replies,
   saves, shares, profile clicks, and next variant.

## Atom Extraction (social-post only)

A full essay won't fit a tweet, so `social-post` is the **one** format where you
reduce the page to a single sharp atom. `article` and `short-video` do not do this
— they render the whole page. When you do extract, keep the atom honest to the
source:

```txt
Thesis:   the claim, taken from the page (not invented).
Tension:  the belief it pushes against — the page's, not a manufactured one.
Proof:    a real artifact, example, diff, screenshot, metric, or quote the page already has.
Audience: who the page already speaks to.
Reaction: save, argue, try, reply, share, click, subscribe.
```

Do not add fake vulnerability, fake lessons, fake metrics, or invented stories to
sharpen the atom. If the page has no proof, the page isn't ready — fix the page.

## Renderer Decision Tree

```txt
Need platform versions of a page?
  -> references/platform-renderers.md.

Writing a social-post and need a strong opening line?
  -> references/hooks.md (social-post only; a short-video has no hook — it opens on
     the page's own words).
```

## Platform Grouping

Treat Instagram Reels, TikTok, and YouTube Shorts as one rendered short-video (one
variant) shipped to three apps (three placements):

```txt
Same:
  the rendered video — one faithful performance of the page. Identical bytes.

Different:
  only each placement's caption. No per-app hook frame, title card, or CTA — the
  timeline is caption-first and chrome-free (ADR-0020, ADR-0021).
```

Treat Medium and Substack as one article renderer with different relationship posture:

```txt
Medium:
  discovery and searchable article.

Substack:
  relationship, continuity, and personal context.
```

Treat LinkedIn and X as related but not identical:

```txt
LinkedIn:
  canonical concise public argument with one strong visual.

X:
  fragments, threads, sharper hooks, higher frequency.
```

Treat Reddit separately:

```txt
Reddit:
  native subreddit post or comment. Rewrite around the community. Do not dump recycled promo.
```

## Source Of Truth

`pages/<slug>.md` is the source. `channel` is the content identity (`bradencodes`, `braden-essays`, `epicenter`, ...). In the sibling vault repo, channel promises live at `../vault/specs/20260609T010000-channel-promise-approval-ledger.md`; read that file before picking a channel for a page for the first time because each channel's "what belongs" and "what does not belong" sections are normative. `format` is `article | social-post | short-video`. A `social-post` body is one or more short written segments separated by `---`: one segment is a one-shot post, several are a thread. `platform` is the distribution surface, and each format ships only to its platform class (the lint enforces this matrix):

```txt
article      → personal-blog | medium | substack | newsletter
social-post  → x | linkedin | reddit
short-video  → instagram | tiktok | youtube
```

A variant's filename is `<page>-<channel>-<format>-<version>` where `version` is the `YYYY-MM-DD` checkpoint the variant was cut from the page:

```txt
pages/2026-06-15-my-page.md
  -> variants/2026-06-15-my-page-bradencodes-social-post-2026-06-20.md
       placements: [{platform: x, published_at, url}]
  -> variants/2026-06-15-my-page-braden-essays-article-2026-06-20.md
       placements: [{platform: personal-blog, published_at, url}]
```

### Freeze-on-supersede

The **latest** variant for a `(page, channel, format)` lineage is living: edit it in place to track the page. Cutting a new version freezes its predecessor — never touch a superseded variant again; it is the curated record of what shipped.

- Content changed enough to preserve the old checkpoint? Cut a **new variant** with today's date as its `version`; the old one freezes.
- Shipping the living variant somewhere (first ship, update, or repost)? Append a **placement** to its `placements[]` — one object per platform shipment.

**What's currently live** is derived, not stored: for a given platform, the current placement is the one with the latest `published_at` on the latest variant that carries that platform. Older variants and placements are history, not stale data to clean up.

Current vault schema: `pages/matter.json` requires `title`, `date`, `timezone`, and `status`; `variants/matter.json` requires `page`, `version`, `channel`, and `format`, with optional `subtitle` (a channel-specific dek; the page's own `title` stays private and canonical). `placements[]` is validated by `bun run publishing-lint`, not Matter: each object has `platform` plus optional `published_at`, `url`, and `caption`. Leave `published_at` off until content is actually live.

## Do Not

- Do not distill or hook-ify an `article` or `short-video` — those render the whole
  page. Only `social-post` extracts an atom.
- Do not generate pure AI images or pure AI videos when the user asked for authentic content from existing materials.
- Do not turn every platform into a separate original writing task.
- Do not optimize for raw volume before a platform wrapper preserves the author's taste.
- Do not add fake vulnerability, fake lessons, fake metrics, or invented personal stories.
- Do not let platform advice override the source thesis.

## Vault References

- `../vault/specs/20260609T010000-channel-promise-approval-ledger.md`: channel promises and what belongs on each channel.
- `../vault/specs/20260611T230004-channel-routing-cheat-sheet.md`: quick channel routing decisions.
- `../vault/specs/20260613T181206-channel-routing-test-batch.md`: examples that test the routing rules against real pages.
