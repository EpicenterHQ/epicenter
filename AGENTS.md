# Epicenter

Local-first workspace platform. Monorepo with Yjs CRDTs and Svelte UI.

Structure: `apps/whispering/` (browser-hostable transcription SPA), `apps/epicenter/` (Tauri host for trusted app surfaces, including Whispering), `apps/tab-manager/` (Chrome extension), `apps/api/` (hosted personal Cloud Worker: `worker/` + `ui/`), `apps/self-host/` (self-hosted single-partition instance reference; Bun or Cloudflare), `apps/theark/` (The Ark public delivery plane: a Worker streaming frozen artifact projections from R2), `packages/server/` (shared Hono library that both deployables consume; deployments differ by principal resolver), `packages/workspace/` (core TypeScript/Yjs library), `packages/cli/` (published CLI package and `epicenter` binary), `packages/ui/` (shadcn-svelte components), `specs/` (planning docs), `docs/` (reference materials).

Planning docs and decisions: Authoritative sources, in order, are `docs/adr/` (durable decisions and their rationale), `docs/CONTEXT.md` (shared vocabulary), package READMEs for package-owned current behavior, and the code. Specs in any `specs/` directory (top-level and per-app or per-package) are in-flight design scaffolding, not current truth; the two-state lifecycle and hygiene gate govern all of them repo-wide. `docs/spec-history.md` is a dated index of past specs and is history, not truth. When a spec conflicts with an ADR or the code, the ADR and code win. A spec has only two states, `Draft` and `In Progress`; "done" is deletion, not a terminal status, so a spec still in the tree declaring `Implemented`/`Superseded` is a hygiene smell (`scripts/check-doc-hygiene.ts` flags it). When a design pass settles a durable decision, record it as an ADR (see `docs/adr/README.md`) and delete the now-spent spec; git keeps the body recoverable.

Deployment seam: One library (`packages/server`), two deployables (`apps/api` = hosted personal cloud, `apps/self-host` = self-hosted single-partition instance reference). Multi-tenancy (many principals, OAuth, billing) is Cloud-only; an instance resolves every valid bearer to the literal `instance` principal (ADR-0075, amended by ADR-0092). Billing (catalog, routes, Autumn) lives in `apps/api/worker/billing/` and is hosted-only; never extract it back to a shared package. The self-hosted instance deployable is community-supported, not Epicenter-operated.

License boundary: apps and `packages/server` are AGPL; the embeddable toolkit packages are MIT (decision procedure in `docs/licensing/licensing-strategy.md`). Moving or copying code from an AGPL package into an MIT one is a relicensing act; `bun run check:licenses` guards dependency edges only and cannot see copied source.

Always use bun: Prefer `bun` over npm, yarn, pnpm, and node. Use `bun run`, `bun test`, `bun install`, and `bun x` (instead of npx).

Local dev: start apps from the repo root with `bun dev:<app>`; it runs every process the app needs, including the hosted API on `localhost:8787` for apps that talk to it. `bun dev:<app>:ui` is the frontend alone when that split exists; `bun dev:api` is the backend alone. Do not cd into an app to start it. Details in the `monorepo` skill.

Agent instruction files: Treat `AGENTS.md` as the canonical shared instructions file. `CLAUDE.md` files are compatibility shims for Claude Code and should only import a sibling `AGENTS.md` with `@AGENTS.md`, plus rare Claude-specific notes if needed. When adding a nested `AGENTS.md`, add a sibling `CLAUDE.md` shim. Do not create orphan `CLAUDE.md` files.

Destructive actions need approval: Force pushes, hard resets (`--hard`), branch deletions.

External grounding: When external library behavior affects correctness, verify against DeepWiki, official docs, or local installed types before changing code. Skip this for stable basics and repo-local patterns already documented in skills.

Git hygiene: Stage specific files only. Never use `git add .` or `git add -A`. Do not include AI or tool attribution in commits.

Review posture: Be direct about flawed assumptions, weak designs, and regressions. Do not agree just to be agreeable.

Coherent edits: Do not default to the smallest local patch. Before changing code, prose, or agent instructions, identify the largest relevant unit whose shape controls the problem, then reconsider that unit as if the new context had always been known. The correct result may still be a small diff, but minimizing the diff is not the goal.

Script suffix convention: `:local` suffix scripts work on a fresh clone without Infisical login (they read committed config like `wrangler.jsonc`). `:remote` suffix scripts wrap with `infisical run --env=prod` and require Infisical authentication; treat them as production admin operations.

Library logging: Do not use direct `console.*` in library code. Use `wellcrafted/logger`, except in CLIs, tests, and benchmarks.

Writing conventions: Avoid en dash characters (`U+2013`). Prefer colon, comma, semicolon, parenthesis, or sentence break over em dash characters (`U+2014`), especially in UI strings, docs, comments, JSDoc, and commit messages. Keep user-facing text direct and concrete. Load `writing-voice` for substantial prose or explicit tone/rewrite work.

Review gates: For substantial implementations, public API changes, refactors, multi-file changes, or user requests to challenge, simplify, clean up, greenfield, or make a clean break, load `post-implementation-review` before final handoff or staging. Load `collapse-pass` directly for continuous indirection-reduction work. During review, escalate to `greenfield-clean-breaks` for ownership, lifecycle, API, package-boundary, clean-break, compatibility-refusal, or asymmetric-win decisions. After a substantive multi-file wave, consider `fresh-context-review` when an independent challenge could catch ownership, lifecycle, or type-shape mistakes; it delegates review, never execution. Keep procedures in skills; keep `AGENTS.md` to routing.
