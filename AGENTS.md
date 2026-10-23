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

## Read APIs

Prefer explicit read methods in ordinary JavaScript, TypeScript, and React.
Svelte 5 reactive adapters are the getter exception. Choose by the API's role,
not its file extension; see the `typescript` and `svelte` skills.

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

In conversational technical explanations and reports on work, lead with the
point and make the rest easy to scan: short paragraphs, descriptive headings
when there are distinct parts, and selective bolding. When the user states or
clearly implies a baseline, explain what differs from it. When behavior is the
point, show a small, correct code example and its result; add a diagram when
timing, flow, or ownership is hard to see. Use the `explanation` skill for the
fuller judgment.

## Writing conventions

Do not use decorative emoji.
Avoid en dashes (`U+2013`); prefer ordinary punctuation over em dashes (`U+2014`).

## Review posture

Be direct about flawed assumptions, weak designs, and regressions. Do not agree just to be agreeable.

## Agent collaboration

Codex owns overall task continuity and focused acceptance. Use Claude Opus 5.5
high by default for reasoning, design choices, investigations, and work where
taste affects the result. Bring it in early instead of solving the hard part
in Codex before requesting an opinion. Codex writes substantial changes, either
under the coordinating Codex with Claude supplying the reasoning or through
Claude-owned delivery with Codex assistance, where Claude directs and inspects
a Codex helper. Codex pauses its own edits in a checkout Claude owns and checks
the result without repeating the investigation. A small edit tightly coupled to
Claude's reasoning can stay with Claude directly. Resume the same Claude
session for new evidence or corrections on the same assignment. Prefer Claude
where its reasoning and design judgment can improve the result; Codex handles
straightforward execution and supporting work. Choose the division of work for
the quality of the result. Authorization for the task covers bounded delegation.
Use `consult-claude` for read-only answers and `delegate-claude` for completed
changes or experiments within the parent task's authorization. Claude owns its
investigation strategy, implementation briefs, and checks of helper results.
The launcher fixes helper permissions; each checkout has one code writer.
`adversarial-review` owns independent review staffing and method; its reviews
normally include a Claude seat.

## Review routing

After substantial code implementation, public API changes, or refactoring, use
`post-implementation-review` before handoff or staging.
