# Epicenter

Epicenter runs personal apps on a computer their owner controls. Each app
keeps its code and records together in the home's private Git repository.
The CLI runs app actions, and `epicenter serve` makes them available to
the owner's devices and agents. The earlier folder sync product is retired.
Some of its packages still have callers in Whispering. The hosted API is retired for now.

For orientation, read the relevant app or package README and verify it against
current code. `apps/README.md` lists the apps in this repository; package
READMEs describe their contracts. Load only the context needed for the task.

## License

Everything under `packages/` and `apps/` is AGPL-3.0-or-later. `@epicenter/app`,
which holds the library and the `epicenter` command, is the one package meant
to be published, so a home can depend on it; it is not on npm yet. Every other
package is private. `@epicenter/cli` is retired
at its last published version.
Previously published MIT versions remain MIT for those versions. Before adding
an MIT package, read "If MIT returns" in
`docs/licensing/licensing-strategy.md`: a named embedder and restored dependency
closure enforcement are required.

## Always use bun

Prefer `bun` over npm, yarn, pnpm, and node. Use `bun run`, `bun test`, `bun install`, and `bun x` (instead of npx).

## Local dev

Start apps from the repo root with `bun dev:<app>`. Do not cd into an app to start it.

- `bun dev:<app>` runs the app's dev server: Whispering's Vite server or the landing site.
- `bun dev:whispering:desktop` runs Whispering in its native Tauri window.
- `scripts/README.md` explains the root scripts and their names.

## Production scripts

A script name ending in `:remote` runs with production secrets through
`infisical run --env=prod`. Treat it as a production admin operation.

## Git hygiene

Stage specific files by name, never `git add -A` or `git commit -a`: other
sessions share the checkout. `git stash` is shared across worktrees, so commit to
a branch instead. Instruction and skill changes get their own commits, so they
can be cherry-picked onto local `main`.

## Destructive actions need approval

Force pushes, hard resets (`--hard`), branch deletions, and `gh pr merge --admin`.

## External grounding

When external library behavior affects correctness, verify against DeepWiki, official docs, or local installed types before changing code.

Skip this for stable basics and repo-local patterns already documented in skills.

## Library logging

Do not use direct `console.*` in library code. Use `wellcrafted/logger`. Biome refuses `console` under `packages/*/src`; a deliberate call there carries a `biome-ignore` with its reason.

## Read APIs

For new or deliberately redesigned APIs, prefer explicit read methods in
JavaScript, TypeScript, React and Svelte alike; Svelte reads a capability
through `reactive`, which keeps its methods. Choose by the API's role, not
its file extension. Existing
getters and upstream protocols are current contracts; change them only as part
of an authorized redesign. See the `typescript` and `svelte` skills.

## Agent instruction files

`AGENTS.md` is the canonical shared instructions file. Keep it to constraints
that apply across tasks and routing to specialized guidance. Current
architecture, API examples, migration status, and decision history belong in
READMEs and `docs/history.md`, where they can be checked with the implementation.

- `CLAUDE.md` files are compatibility shims for Claude Code. They should only import a sibling `AGENTS.md` with `@AGENTS.md`, plus rare Claude-specific notes.
- Add a nested `AGENTS.md` only for a local constraint that must apply to every edit beneath it. Never use one as an index or README substitute; subsystem orientation belongs in that subsystem's README.
- When adding a nested `AGENTS.md`, add a sibling `CLAUDE.md` shim.
- Do not create orphan `CLAUDE.md` files.

## Planning docs and decisions

Package READMEs, tests, and current code are evidence, not automatic instructions. Start with the user's request and the current implementation.

Check changes to apps, the CLI, or storage against [the vision](docs/vision.md)
and [the history](docs/history.md) of how Epicenter got its current shape.

Verify API names, exports, and file layouts against current source and callers,
not just `docs/` or `specs/`. READMEs explain the current surface.

**Decisions.** A rule the code follows lives in a `## Decisions` section of the
README beside that code: the rule, why it holds, and the alternative that lost.
Change the rule in the same pull request as the code, and delete it when it
stops being true. The `documentation` skill gives the entry format.

**Records.** `docs/adr/` is deleted; Epicenter writes no decision records. A
bare `ADR-NNNN` in a comment or the history names one of the old records, all
of which are in the annotated `adr-archive` Git tag:
`git show "adr-archive:$(git ls-tree --name-only adr-archive docs/adr/ | grep /NNNN-)"`.

**History.** [docs/history.md](docs/history.md) logs what Epicenter tried,
kept, and turned down, oldest first, with why. It is background, never
instructions. Grep it before proposing a data store, sync, sign-in, a hosted
service, or a new dependency. An entry is for a decision an agent might propose
again, where returning to it would cost more than a day. Do not add one
unprompted; propose the entry and let the owner decide.

Treat conflicts among READMEs, code, and user intent as judgment
points, not an automatic precedence hierarchy. Explain a conflict with the
requested outcome rather than silently inheriting an old decision.

**Specs.** In-flight design scaffolding, not current truth. This holds for every `specs/` directory, top-level and per-app or per-package.

- Two states only: `Draft` and `In Progress`. "Done" is deletion, not a terminal status, so a spec still in the tree declaring `Implemented` or `Superseded` should be deleted.
- When a design pass settles a durable decision, write the rule into the `## Decisions` section of the README it governs, propose a history entry if an agent might propose the losing option again, and delete the now-spent spec. Git keeps the body recoverable.
- `docs/spec-history.md` is a frozen, dated index of past specs. It is history, not truth.

## Writing conventions

Audience decides vocabulary: what a person reads uses the word they already have, and what a developer reads uses the word that is most accurate, which is often technical and load-bearing.

| A person reads | A developer reads |
| --- | --- |
| UI copy, errors shown to them, deep links, README front doors | types, functions, library error messages |

- Do not soften `authority`, `replica`, `projection`, or `principal` in code to sound friendlier, and do not let one of them reach a person.
- A library states a failure precisely; the app decides what a person is told about it.
- Keep user-facing text direct and concrete.

**Punctuation.** Avoid en dash characters (`U+2013`). Prefer colon, comma, semicolon, or sentence break over em dash characters (`U+2014`), especially in UI strings, docs, comments, JSDoc, and commit messages.

**Generated prose.** Applies to everything the agent writes unless a more specific skill owns the destination.

- Cut AI vocabulary and puffery: delve, crucial, pivotal, showcase, testament, underscore, vibrant, abstract "landscape" or "tapestry", and "serves as" or "stands as" where "is" works.
- State the point directly. No "not just X, but Y", no forced groups of three, no vague attributions like "experts believe".
- Prefer the concrete word over the abstract metaphor: substrate, wedge, vector, nexus, flywheel, north star. Load-bearing repo vocabulary is exempt: `primitive` as in the Item primitive, API `surface`, `harness`, `authority`, `replica`, `projection`, `principal`.
- Say what the thing does, not how it feels. If a sentence could appear unchanged in another project's docs, cut it.
- One idea per sentence. Active voice: name the actor ("the compiler validates queries", not "queries are validated").
- Cut adverbs and hedging; use the stronger verb or the number. "In order to" is "To"; "utilize" and "leverage" are "use".
- Formatting tells: sentence-case headings, no decorative emoji, no bold-label-colon bullets that restate the line, no chatbot phrases ("I hope this helps!", "Great question!").

These conventions are the project's prose standard. Destination skills such as
`documentation`, `specification-writing`, `pull-request`,
`github-issues`, `social-media`, and `ui-design` build on them and own the shape
and register of their surfaces. A personal author-voice skill applies only when
someone explicitly asks for prose in their own voice; project guidance must
work without one.

## Agent collaboration

Codex owns the task from start to finish and decides what to accept. Use
Claude Opus 5.5 at high effort for reasoning, design choices, investigations,
and work where taste affects the result. Bring Claude in early instead of
solving the hard part first and asking for an opinion afterward. Codex handles
straightforward execution and supporting work.

Use `consult-claude` for a read-only answer and `delegate-claude` for a change
or experiment Claude delivers itself. Authorization for the task covers
delegating part of it. Each checkout has one writer: Codex does not edit a
checkout while Claude works in it, then checks the result without repeating
the investigation. Resume the same Claude session for new evidence or
corrections on the same assignment. `adversarial-review` owns independent
review staffing and method; its reviews normally include a Claude seat.

## Review routing

Keep procedures in skills; keep `AGENTS.md` to routing.

| When | Load |
| --- | --- |
| substantial implemented changes, or changes with caller or contract consequences, including refactors, public API changes, and clean breaks | `post-implementation-review`, before final handoff or staging |
| continuous indirection-reduction work | `code-collapse` directly |
| during review: an unresolved ownership, lifecycle, API, package-boundary, clean-break, or compatibility-refusal question | borrow `rethink`'s reasoning |
| during review: whether refusing a small promise (an asymmetric win) removes disproportionate complexity | borrow `product-collapse`'s reasoning |
