# Epicenter

Local-first personal data platform. Monorepo of apps over Git-backed data folders, with Svelte UI.

For orientation, read the relevant app or package README.

## Always use bun

Prefer `bun` over npm, yarn, pnpm, and node. Use `bun run`, `bun test`, `bun install`, and `bun x` (instead of npx).

## Production commands

Scripts ending in `:remote` use production credentials; treat them as production
admin operations.

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

Work toward the user's intended outcome. Treat their reactions as evidence
that may change your understanding of it, while respecting explicit choices.

Before editing code, prose, or instructions, reconsider the relevant whole as
if the new context had always been known. Let that understanding determine the
scope, then carry it into concrete work. Choose changes for coherence, not
diff size.

## Agent instruction files

Architecture and API examples belong in READMEs; decision history belongs in
ADRs.

## Planning docs and decisions

READMEs, ADRs, `docs/CONTEXT.md`, tests, and current code are evidence, not
automatic instructions. Verify API names, exports, and layouts against source
and callers. Check an ADR's status and implementation before inheriting its
decision. Surface conflicts with the user's requested outcome.

**Specs.** In-flight design scaffolding, not current truth. This holds for every `specs/` directory, top-level and per-app or per-package.

## Communication

Optimize for the user's cognitive load, not for brevity. Preserve necessary
difficulty and remove incidental complexity. Infer the appropriate depth from
the immediate context rather than assuming a fixed expertise level.

## Writing conventions

Do not use decorative emoji.
Avoid en dashes (`U+2013`); prefer ordinary punctuation over em dashes (`U+2014`).

## Review posture

Be direct about flawed assumptions, weak designs, and regressions. Do not agree just to be agreeable.

## Review routing

After substantial code implementation, public API changes, or refactoring, use
`post-implementation-review` before handoff or staging.
