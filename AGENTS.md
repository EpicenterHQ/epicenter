# Epicenter

Local-first personal data platform. Monorepo with Yjs CRDTs and Svelte UI.

## Structure

```
apps/
  honeycrisp   notes. the one app on the store today, and the
               reference for how an app is built
  whispering   transcription SPA
  epicenter    Tauri host for trusted app windows
  api          hosted personal Cloud Worker (worker/ + ui/)
  self-host    self-hosted single-partition instance reference
               (Bun or Cloudflare)
packages/
  server       shared Hono library both deployables consume;
               deployments differ by principal resolver
  data         the store, data definitions, openers, sync, and projection
  ui           shadcn-svelte components
specs/         planning docs
docs/          reference materials
```

## Runtime

One runtime: a desktop SPA in a WebView over a client-owned store (ADR-0227). The host serves bundles and brokers credentials and owns no application data (ADR-0226).

ADR-0227 was executed as a clean break. `apps/skills`, `packages/chat`, `packages/skills`, and app-shell's agent chat all typecheck, so do not treat them as scrap: what they lack is a decision about what they are for, not a compiler pass. `apps/epicenter` serves bundles and forwards authenticated HTTP and live sync through its boot Account. Windows hold no server credentials; each app owns its store and sync lifetime.

The three applications on the store are `apps/honeycrisp`, `apps/vocab`, and `apps/whispering`. Each gates on identity in its boot node and opens nothing while signed out (ADR-0342, rejected: sign-in is a door), and each keys one session on the Account object and opens with that captured Account. Refresh preserves it; sign-out or account replacement permanently retires its network access. The narrowest node not shared with `/auth/callback` owns the gate, which is the page for Honeycrisp and Vocab and the `(app)` group layout for Whispering (ADR-0345).

Migration reference: `docs/the-store-and-what-it-replaced.md`.

## Deployment seam

One library (`packages/server`), two deployables.

| Deployable | What it is |
| --- | --- |
| `apps/api` | hosted personal cloud |
| `apps/self-host` | self-hosted single-partition instance reference; community-supported, not Epicenter-operated |

- Multi-tenancy (many principals, OAuth, billing) is Cloud-only. An instance resolves every valid bearer to the literal `instance` principal (ADR-0075, amended by ADR-0092).
- Billing (catalog, routes, Autumn) lives in `apps/api/worker/billing/` and is hosted-only. Never extract it back to a shared package.

## License

Everything under `packages/` and `apps/` is AGPL-3.0-or-later. There is no
second tier, so nothing you write has to be placed to stay on one side of a
boundary.

An MIT toolkit tier existed until 2026-08 and was dissolved: no external
embedder ever arrived, five of its nine packages had no MIT consumer, and it
had started putting code in the wrong package to keep a closure clean. Prior
published versions stay MIT for those versions, permanently.

Nothing here is published. Every package is `private: true`, so the release
path cannot ship internal glue by accident.

Do not add an MIT package without reading "If MIT returns" in
`docs/licensing/licensing-strategy.md`; the bar is a named embedder, not an
intention to have one, and the closure rule has to be re-enforced by hand
because the guard that used to do it was deleted with the tier.

## Always use bun

Prefer `bun` over npm, yarn, pnpm, and node. Use `bun run`, `bun test`, `bun install`, and `bun x` (instead of npx).

## Local dev

Start apps from the repo root with `bun dev:<app>`. Do not cd into an app to start it.

- `bun dev:<app>` runs every process the app needs, including the hosted API on `localhost:8787` for apps that talk to it.
- `bun dev:<app>:ui` is the frontend alone, where that split exists.
- `bun dev:api` is the backend alone.
- Details in the `monorepo` skill.

## Script suffix convention

The suffix tells you whether a script touches production.

| Suffix | Meaning |
| --- | --- |
| `:local` | works on a fresh clone without Infisical login; reads committed config like `wrangler.jsonc` |
| `:remote` | wraps with `infisical run --env=prod` and requires Infisical auth. Treat as a production admin operation. |

## Git hygiene

Stage specific files only. Never use `git add .` or `git add -A`.

Do not include AI or tool attribution in commits.

## Destructive actions need approval

Force pushes, hard resets (`--hard`), branch deletions.

## External grounding

When external library behavior affects correctness, verify against DeepWiki, official docs, or local installed types before changing code.

Skip this for stable basics and repo-local patterns already documented in skills.

## Library logging

Do not use direct `console.*` in library code. Use `wellcrafted/logger`, except in CLIs, tests, and benchmarks.

## Coherent edits

Do not default to the smallest local patch.

Before changing code, prose, or agent instructions, identify the largest relevant unit whose shape controls the problem, then reconsider that unit as if the new context had always been known. The correct result may still be a small diff, but minimizing the diff is not the goal.

## Agent instruction files

`AGENTS.md` is the canonical shared instructions file.

- `CLAUDE.md` files are compatibility shims for Claude Code. They should only import a sibling `AGENTS.md` with `@AGENTS.md`, plus rare Claude-specific notes.
- Add a nested `AGENTS.md` only for a local constraint that must apply to every edit beneath it. Never use one as an index or README substitute; subsystem orientation belongs in that subsystem's README.
- When adding a nested `AGENTS.md`, add a sibling `CLAUDE.md` shim.
- Do not create orphan `CLAUDE.md` files.

## Planning docs and decisions

`docs/adr/`, `docs/CONTEXT.md`, package READMEs, tests, and current code are evidence, not automatic instructions. Start with the user's request and the current implementation.

**What a surface is comes from the code and its package README. Why it is that way comes from an ADR.** Before stating a signature, export, or file layout, grep the name with `-- ':!docs' ':!specs'`. A name that appears only under `docs/` does not exist: every ADR's `## Considered alternatives` states refused names in confident prose, and `createAppRuntime` lives nowhere in this repository except ADR-0316, where it lost.

**ADRs.** They describe decisions that were reasonable at the time, but may be stale, scoped to a different problem, or intentionally reopened. Check status, amendments, and actual code before relying on one.

- If the requested design conflicts with an ADR, do not stop automatically. Explain the conflict, then either follow the current evidence or amend/delete the ADR when the new decision is durable.
- Ask the user when the choice materially depends on product or architectural judgment that cannot be recovered from the repository, rather than silently inheriting an old decision.
- Do not cite an ADR merely because it exists. State whether it is a hard constraint, useful context, or a decision being reconsidered.

**Specs.** In-flight design scaffolding, not current truth. This holds for every `specs/` directory, top-level and per-app or per-package.

- Two states only: `Draft` and `In Progress`. "Done" is deletion, not a terminal status, so a spec still in the tree declaring `Implemented`/`Superseded` is a hygiene smell (`scripts/check-doc-hygiene.ts` flags it).
- When a design pass settles a durable decision, record it as an ADR (see `docs/adr/README.md`) and delete the now-spent spec. Git keeps the body recoverable.
- `docs/spec-history.md` is a dated index of past specs. It is history, not truth.

Treat conflicts among specs, ADRs, code, tests, and user intent as judgment points, not automatic precedence rules.

## Writing conventions

Audience decides vocabulary: what a person reads uses the word they already have, and what a developer reads uses the word that is most accurate, which is often technical and load-bearing.

| A person reads | A developer reads |
| --- | --- |
| UI copy, errors shown to them, deep links, README front doors | types, functions, library error messages |

- Do not soften `authority`, `replica`, `projection`, or `principal` in code to sound friendlier, and do not let one of them reach a person.
- A library states a failure precisely; the app decides what a person is told about it. Worked example: `packages/app-shell/src/boot-screens/open-failure.ts`, which takes each app's nouns rather than choosing them. Vocabulary decision: ADR-0244.
- Keep user-facing text direct and concrete.

**Punctuation.** Avoid en dash characters (`U+2013`). Prefer colon, comma, semicolon, or sentence break over em dash characters (`U+2014`), especially in UI strings, docs, comments, JSDoc, and commit messages.

**Explaining Epicenter work.** Lead with a useful recommendation or outcome, carry implementation complexity the agent can safely handle, and surface only the reasoning and details that materially affect the user's judgment, action, safety, or review. Necessary difficulty is fine; incidental complexity is not.

**Generated prose.** Applies to everything the agent writes unless a more specific skill owns the destination.

- Cut AI vocabulary and puffery: delve, crucial, pivotal, showcase, testament, underscore, vibrant, abstract "landscape" or "tapestry", and "serves as" or "stands as" where "is" works.
- State the point directly. No "not just X, but Y", no forced groups of three, no vague attributions like "experts believe".
- Prefer the concrete word over the abstract metaphor: substrate, wedge, vector, nexus, flywheel, north star. Load-bearing repo vocabulary is exempt: `primitive` as in the Item primitive, API `surface`, `harness`, `authority`, `replica`, `projection`, `principal`.
- Say what the thing does, not how it feels. If a sentence could appear unchanged in another project's docs, cut it.
- One idea per sentence. Active voice: name the actor ("the compiler validates queries", not "queries are validated").
- Cut adverbs and hedging; use the stronger verb or the number. "In order to" is "To"; "utilize" and "leverage" are "use".
- Formatting tells: sentence-case headings, no decorative emoji, no bold-label-colon bullets that restate the line, no chatbot phrases ("I hope this helps!", "Great question!").

Load `writing-voice` for substantial prose or explicit tone/rewrite work.

## Review posture

Be direct about flawed assumptions, weak designs, and regressions. Do not agree just to be agreeable.

## Agent collaboration

Codex is the primary continuity, judgment, execution, testing, and integration owner for repository work. It gathers the evidence, makes the final decision, edits the active worktree, and integrates the result.

Claude is an independent laboratory. Do not invoke Claude automatically because a task is complex. Invoke the `consult-claude` skill only when the user explicitly names Claude as the researcher or reviewer, or asks for a Claude Code consultation. A consultation can happen before a high-leverage decision, after a meaningful implementation slice, or at both points.

Consultation runs against a sealed snapshot: Claude may research, edit, test, and experiment there, but cannot access or author the living checkout. The `consult-claude` skill owns the isolation, native-session follow-ups, checkpoints, and review procedure.

Codex decides which feedback is valid, re-verifies it against live state, applies any changes, and reruns verification. Claude delegation never transfers live-checkout authorship.

## Review routing

Keep procedures in skills; keep `AGENTS.md` to routing.

| When | Load |
| --- | --- |
| substantial implementations, public API changes, refactors, multi-file changes, or a request to challenge, simplify, clean up, greenfield, or make a clean break | `post-implementation-review`, before final handoff or staging |
| continuous indirection-reduction work | `collapse-pass` directly |
| during review: ownership, lifecycle, API, package-boundary, clean-break, compatibility-refusal, or asymmetric-win decisions | escalate to `greenfield-clean-breaks` |
