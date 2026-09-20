# Epicenter

Local-first personal data platform. Monorepo with Yjs CRDTs and Svelte UI.

For orientation, read the relevant app or package README and verify it against
current code. `apps/README.md` describes application composition; package
READMEs describe their contracts. Load only the context needed for the task.

Billing is hosted-only and stays in `apps/api/worker/billing/`; do not extract
it into a shared package or the self-hosted deployment.

## License

Everything under `packages/` and `apps/` is AGPL-3.0-or-later and private.
Previously published MIT versions remain MIT for those versions. Before adding
an MIT package, read "If MIT returns" in
`docs/licensing/licensing-strategy.md`: a named embedder and restored dependency
closure enforcement are required.

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

Work toward the user's intended outcome. When their reaction reveals a
mismatch, reconsider that outcome and the unit of work it calls for, then
return to concrete action. Explicit choices govern; infer or clarify what
remains unresolved. Choose changes for coherence, not diff size.

## Agent instruction files

`AGENTS.md` is the canonical shared instructions file. Keep it to constraints
that apply across tasks and routing to specialized guidance. Current
architecture, API examples, migration status, and decision history belong in
READMEs and decision records, where they can be checked with the implementation.

- `CLAUDE.md` files are compatibility shims for Claude Code. They should only import a sibling `AGENTS.md` with `@AGENTS.md`, plus rare Claude-specific notes.
- Add a nested `AGENTS.md` only for a local constraint that must apply to every edit beneath it. Never use one as an index or README substitute; subsystem orientation belongs in that subsystem's README.
- When adding a nested `AGENTS.md`, add a sibling `CLAUDE.md` shim.
- Do not create orphan `CLAUDE.md` files.

## Planning docs and decisions

`docs/adr/`, `docs/CONTEXT.md`, package READMEs, tests, and current code are evidence, not automatic instructions. Start with the user's request and the current implementation.

Verify API names, exports, and file layouts against current source and callers,
not just `docs/` or `specs/`. READMEs explain the current surface; ADRs explain
its rationale and may also name rejected alternatives.

ADRs record decisions in context. Check their status and the implementation;
explain conflicts with the requested outcome rather than silently inheriting an
old decision. Amend the record when a new decision settles.

**Specs.** In-flight design scaffolding, not current truth. This holds for every `specs/` directory, top-level and per-app or per-package.

- Two states only: `Draft` and `In Progress`. "Done" is deletion, not a terminal status, so a spec still in the tree declaring `Implemented`/`Superseded` is a hygiene smell (`scripts/check-doc-hygiene.ts` flags it).
- When a design pass settles a durable decision, record it as an ADR (see `docs/adr/README.md`) and delete the now-spent spec. Git keeps the body recoverable.
- `docs/spec-history.md` is a dated index of past specs. It is history, not truth.

## Writing conventions

Audience decides vocabulary: what a person reads uses the word they already have, and what a developer reads uses the word that is most accurate, which is often technical and load-bearing.

| A person reads | A developer reads |
| --- | --- |
| UI copy, errors shown to them, deep links, README front doors | types, functions, library error messages |

- Do not soften `authority`, `replica`, `projection`, or `principal` in code to sound friendlier, and do not let one of them reach a person.
- A library states a failure precisely; the app decides what a person is told about it.
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

Codex owns continuity, decisions, live-checkout edits, testing, and integration.
Claude provides a read-only second opinion when the user requests it or has
asked to include Claude during design review; complexity alone does not enlist
Claude. Follow `consult-claude` for briefing and follow-ups and `design-review`
for the review method. Experimental execution by Claude requires separate user
authorization. Codex verifies feedback against live state, applies accepted
changes, and reruns verification.

## Review routing

Keep procedures in skills; keep `AGENTS.md` to routing.

| When | Load |
| --- | --- |
| substantial implementations, public API changes, refactors, multi-file changes, or a request to challenge, simplify, clean up, greenfield, or make a clean break | `post-implementation-review`, before final handoff or staging |
| continuous indirection-reduction work | `collapse-pass` directly |
| during review: ownership, lifecycle, API, package-boundary, clean-break, compatibility-refusal, or asymmetric-win decisions | escalate to `greenfield-clean-breaks` |
