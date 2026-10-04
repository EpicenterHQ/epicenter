# Platform Renderers

Render one source idea into native platform shapes. Change wrappers, not the thesis.

## LinkedIn

Best default:

```txt
short post
  + one strong real visual
  + title overlay when useful
```

Use:

- Personal photo with title overlay.
- Screenshot with title overlay.
- ASCII diagram rendered cleanly.
- Code diff or product screenshot with one claim.
- 5 to 10 lines of text.

Optimize for:

- A specific opinion.
- A real work story.
- A technical lesson.
- A before and after.
- A mistake or changed mind the author can defend.

Avoid:

- Generic long essays.
- Hashtag stacks.
- "Excited to announce" unless the announcement itself is the story.

## X

Best default:

```txt
single sharp post
or 3 to 6 post thread
```

Use:

- Fragments from the source article.
- Screenshot plus one-line claim.
- ASCII diagram.
- Build-in-public note.
- Strong replies to other posts.

Optimize for:

- Frequency.
- Sharp claims.
- Reusable phrasing.
- One idea per post.

## Reddit

Best default:

```txt
subreddit-native post or comment
```

Use:

- Implementation detail.
- Honest tradeoff.
- Concrete code or screenshot.
- A real question to the community.

Rules:

- Rewrite for the subreddit.
- Do not sound like a recycled LinkedIn post.
- Keep self-promotion secondary and only when relevant.
- Prefer comments when the source idea responds to an existing discussion.

## Instagram Reels, TikTok, YouTube Shorts

One rendered short-video (one variant) ships to all three apps; only each
placement's caption differs. The short-video is a **faithful full performance of
one page** (ADR-0021) — not a slideshow assembled from wrappers.

Best default:

```txt
caption-first performance of the page
  + the page's prose spoken (narration + captions), alive from frame 0
  + headings pace the timeline and draw no pixels
  + rare real artifacts (image / code / quote) take the stage as evidence
```

The variant `.md` body is the script AND the storyboard:

- **Prose** is spoken and rendered as the caption canvas.
- **Headings** (`##`, `###`) pace the script and bound artifacts — they draw no pixels.
- A **display block** — a markdown image, fenced code, or `> blockquote` — is a
  silent evidence artifact, authored immediately *before* the prose it illustrates
  (ADR-0019). Lists are refused: write them as prose or show the real artifact.
- To show **and** speak a quote, author it twice: a `> blockquote` (the shown
  artifact) plus a prose line (the spoken caption). Artifacts are never voiced.

There is no hook frame, title card, CTA, or slide. Browse identity is a separate
cover Still (`bun run cover`), never chrome inside the timeline (ADR-0020).

Pipeline (`narrate` needs the ElevenLabs secrets — see AGENTS.md for the
`infisical run` wrapper):

```txt
bun run cues <slug>     # preview heading/artifact cue timing, no paid narration
bun run narrate <slug>  # ElevenLabs → narration.mp3 + .captions.json + .cues.json
bun run render <slug>   # dist/video.mp4
bun run cover <slug>    # dist/cover.png (browse identity)
```

If a page won't fit one reel, **split the page** (ADR-0021) — do not compress it
into a faster slideshow.

## Instagram Static Or Carousel

Refused. The format→platform matrix reaches Instagram only as a `short-video`;
there is no static or carousel format (ADR-0005 refuses carousel until a real one
recurs). A photo-plus-lesson idea ships as a `social-post` elsewhere or as a
short-video, not an Instagram carousel.

## Medium

Best default:

```txt
500 to 900 word article
  + one thesis
  + one concrete example
  + one to three visuals
```

Optimize for:

- Searchable title.
- Durable explanation.
- Discovery.

## Substack

Best default:

```txt
same article as Medium
  + more personal context
  + continuity with previous thinking
```

Optimize for:

- Relationship.
- Series.
- Reader replies.

## Distribution State

Best default:

```txt
variants/*.md placements[]
  + destination wrappers
  + attempts
  + performance notes
```

A variant's `placements[]` should own distribution state, not the source idea. `pages/` owns finished writing. The variant owns the shaped artifact; its placements own where it went, what wrapper was used, and what happened next.
