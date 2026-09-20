---
name: agent-instructions
description: Design, audit, and validate repository guidance across AGENTS.md, CLAUDE.md, and `.agents/skills`. Use when creating skills, tuning descriptions, or reviewing instruction sprawl and routing.
---

# Agent Instructions

Agent Instructions owns the architecture and maintenance of repository guidance across `AGENTS.md`, `CLAUDE.md`, and `.agents/skills`.

The Vercel `skills` CLI is the source of truth for format and discovery. Do not maintain a separate local validator unless the user explicitly asks for one.

Skills should encode repeatable project expertise: real conventions, recurring failure modes, fragile workflows, and corrections the agent would otherwise miss. Do not turn one-off advice into a skill.

Read [references/instruction-placement.md](references/instruction-placement.md) when adding or moving guidance, editing `AGENTS.md` or `CLAUDE.md`, deciding whether a rule should be always loaded or triggerable, or reducing instruction sprawl.

Read [references/evaluation.md](references/evaluation.md) when tuning trigger descriptions, comparing skill versions, evaluating behavior, auditing imported skills, or checking source links.

Read [references/composition-audit.md](references/composition-audit.md) when stress-testing how a *cluster* of skills composes rather than one skill: after extracting, merging, or renaming a skill, after adding a trigger phrase, or when routing feels ambiguous. It carries the role model (hub / move / mechanic / adapter), the mechanical detectors (routing collisions, duplicated bodies, dead links, coupling), and the continuous audit loop.

## Compose With

Use other skills for their owned domains:

- `dialectic`: settle what a skill is for before this skill settles what using it
  should feel like.
- `writing-voice`: user-facing prose, UI text, errors, docs, and tone.
- `page-writing` and `journal-writing`: authored Vault prose. Loading one inside
  a skill run is execution, not skill design; this skill's discovery pass does
  not apply there.
- Domain skills such as `yjs`, `svelte`, or `auth`: package conventions the new skill must encode.
- `git`: staging, commits, branch work, and commit messages.
- `plugin-creator`: Codex plugins, not agent skills.
- `skill-installer`: installing third-party skills.

## Decide Update Or New

Update an existing skill when it already owns the same user intent. Create a new skill only when the task is a separate coherent capability with distinct triggers.

Split a skill only when workflows are mutually exclusive, the routing description becomes broad or ambiguous, or a reference file would be loaded for the wrong jobs. Prefer small composable skills over broad manuals.

## Supported Shape

Every skill is a flat directory with a required `SKILL.md`:

```txt
.agents/skills/<skill-name>/
|-- SKILL.md
|-- references/   optional, detailed context loaded only when needed
|-- scripts/      optional, executable helpers for repeatable fragile work
|-- assets/       optional, files used in generated output
|-- evals/        optional, stored prompt corpora and recorded runs
```

Use `.agents/skills` for project-local portable skills. The Vercel CLI discovers this path, and Codex uses it as the project skill location.

The required frontmatter is:

```yaml
---
name: skill-name
description: What this skill does and when agents should use it.
---
```

Use lowercase hyphenated names. Vercel CLI discovery only requires `name` and
`description`, and treats `metadata.internal: true` specially for hidden
internal skills. The broader Agent Skills format also permits useful optional
fields such as `license`, arbitrary `metadata`, `argument-hint`, and
`disable-model-invocation`. Do not remove those fields just because Vercel CLI
does not need them for `--list`.

Use optional frontmatter intentionally:

- `argument-hint`: slash-invoked skills that need user input.
- `disable-model-invocation`: skills that should be explicit-only, not
  model-auto-invoked.
- `license`: bundled or imported skills whose license terms matter.
- `metadata`: provenance, version, or internal routing facts that a client may
  preserve even if another client ignores them.

Avoid agent-specific execution-control fields such as `allowed-tools`, hooks,
and `context: fork` unless the user explicitly targets an agent that supports
them.

## Keep The Format Open

A skill is a directory with a `SKILL.md`, and `name` plus `description` is the
whole discovery contract every host reads. What one host adds on top belongs to
that host's installation, not to a repository skill:

```txt
agents/openai.yaml               Codex skill-list interface
references/openai_yaml.md        its field reference
scripts/generate_openai_yaml.py  its generator
scripts/init_skill.py            Codex scaffold
scripts/quick_validate.py        Codex frontmatter validator
decorative assets
```

Carrying those here would tie a portable skill to one host and would stand a
second format validator next to the Vercel CLI, which already owns format and
discovery. A script that checks something the CLI does not look at, such as
whether a Markdown link resolves, is a different job and is fine to keep.

Codex ships its own `skill-creator` under `${CODEX_HOME:-$HOME/.codex}/skills/.system/`,
and that guide teaches the list above. Treat that directory as host-owned rather
than a supported persistence point: packaged manifests and installation markers
show Codex manages it, so a local edit may be regenerated. Guidance that has to
survive belongs here, or in `~/Code/dotfiles` when it should follow you across
repositories.

## Create A Skill

Default to project-local skills:

```bash
cd /Users/braden/Code/epicenter/.agents/skills
bun x --package skills skills init <skill-name>
```

Edit `.agents/skills/<skill-name>/SKILL.md` directly, then add the sibling
symlink from the repository root so Claude sessions discover it in every
worktree:

```bash
cd /Users/braden/Code/epicenter
ln -s ../../.agents/skills/<skill-name> .claude/skills/<skill-name>
```

Relative, never absolute: an absolute link pins every checkout to one working
copy. Skip the link only for a skill written for a Codex session, which is why
`consult-claude` and `codex-task-backlog-hygiene` have none.
Delete the link in the same change that deletes the skill.

Ground the skill in real source material: completed tasks, diffs, review
comments, issue threads, runbooks, execution traces, and repeated corrections.
A skill carries what an agent could not have inferred here, so a section you
could have written without opening the repository is a section to cut. When the
task, its triggers, or the failure it prevents cannot be recovered from repo
files, ask before drafting rather than inventing them.

## Design The Skill From The Interaction

This pass happens while a `SKILL.md` is being written or behaviorally revised.
A skill run follows that skill's body; it never renders candidate interactions
unless the body asks for them. A typo-only edit or a clearly settled instruction
skips this pass; act directly.

Use concrete candidate interactions when the intended behavior is hard to
judge in prose. Revise them from the user's reactions until the useful
behavior is recognizable. Existing conversation evidence may already settle
that question; do not repeat the exercise merely to follow a process.

Extract the judgment that made an interaction work, not its incidental topic,
wording, layout, or turn count. An approved example is evidence for a principle,
not permission to make every future interaction resemble it. Keep examples in
evaluations or references when they test or explain something the principle
cannot carry alone.

Before encoding the lesson, vary the subject, the user's certainty, and the
kind of artifact they need. The instruction should still help, including when
the right response is immediate action or no question. If preserving a template
requires exceptions for those cases, reconsider the template instead of adding
more guardrails.

When the goal itself is unsettled, run `dialectic` first; this pass assumes the
goal is settled and only the interaction's shape is open.

## Write The Description First

The description is always loaded and drives selection. It must carry the trigger logic, because the body is what an agent reads only after choosing the skill.

Do not add body sections like `When to apply this skill`, `When to load`, `Trigger phrases`, or `Use this skill when...`. Put routing in the frontmatter description; use the body for workflow, guardrails, examples, and final checks.

The body is still not routing-neutral. Rewriting `handoff`'s body while leaving its name and description byte-identical flipped `enlistment-hand-off-near-miss` from 3/3 not-loading to 3/3 loading under `--live`, reproducible across several runs each way. The mechanism is not established, and the fix is not to move trigger language into the body: re-run the affected `--live` cases after a substantial body rewrite, and treat a routing change as a real result rather than noise.

Include:

1. What the skill does.
2. Concrete situations that should trigger it.
3. Important file types, packages, tools, or phrases the user might mention.

Use `Use when...` phrasing. Describe user intent, not implementation mechanics. Keep the description concise and under the 1024 character limit.

Good:

```yaml
description: Epicenter data API patterns for defineApp, defineTable, table reads and writes, observation, artifacts, and sync attachment. Use when defining schemas, reading or writing data, observing changes, exporting artifacts, or composing sync.
```

Weak:

```yaml
description: Helps with workspace stuff.
```

For subtle routing, test 2 or 3 should-trigger prompts and 1 or 2 near-miss should-not-trigger prompts. Do not stuff exact keywords unless the keyword represents a real trigger category.

End with what the skill is not for. `Do not use for...` is the only place a near
miss can be excluded, because the body loads after routing has already failed.

## Guide Without Over-Steering

A skill is read by something that can already reason. Its job is to land that
judgment on this codebase, not to replace it with a script. Over-steering is the
failure where an instruction is so specific it stops generalizing: the agent
applies it correctly to the case you wrote down and wrongly to the next one.

State the premise the skill runs on once, at the top, and derive the rest from
it. An agent holding the premise can answer a case you never wrote down. An
agent holding twenty disconnected rules cannot.

Attach the reason to the rule, in the same sentence. "Never flatten a JWKS fetch
failure into a 401" is a rule the agent can only obey. "Never flatten it, or a
transient fault makes clients discard a good token" is a rule the agent can
extend. A rule whose reason you cannot state in a clause is usually taste, and
belongs in a reference or nowhere.

Give a criterion, not a threshold. "Keep at 4+ callers" makes the agent count
instead of think, and then needs three later sections to walk itself back. "Does
this function earn its name" needs none. Reach for a number only when the number
is the actual constraint, like a token limit or a timeout.

Bound the rule on both sides. Every instruction has an overshoot and the agent
will find it, so say what too little looks like as well as too much. Rules
stated one-sided get applied until they break.

Diagnose an anti-pattern where it happens, not in a list at the end. Name the
move, then the consequence that makes it wrong. A closing `Anti-Patterns` or
`Best Practices` section is a second copy of rules already stated; the two
copies drift to different calibrations, and the agent obeys whichever it read
last.

Match form to the work. Keep the reason connected to the instruction and make
commands, paths, and structures easy to inspect. Judge the format by whether it
preserves those relationships, not by whether it uses prose, lists, or blocks.

Say what done means as a property, and name its false positive. "Both of you can
reason forward from it" is checkable. "The review is complete" is not.

Guide the decisions that matter; leave the route to the agent. Add procedural
detail when the work's safety or correctness depends on the order, and not
otherwise.

[dialectic](../dialectic/SKILL.md) is the worked example: compact prose, no
bullets, every rule carrying its reason. Read it when a skill you are writing
has turned into a list.

## Use Progressive Disclosure

Put only essential workflow in `SKILL.md`. Aim for under 100 lines when practical, and keep the Vercel guideline of under 500 lines as the outer bound.

Use this split:

- `SKILL.md`: core rules, recurring gotchas, decision points, commands, and links.
- `references/`: long examples, conditional gotchas, eval notes, decision tables, API details, and edge cases.
- `scripts/`: repeated deterministic helpers the agent would otherwise recreate.
- `assets/`: templates, images, boilerplate, or other files used in generated output.

Keep routing at the right layer:

```txt
description   external routing: "Use when..."
SKILL.md      ownership and workflow after the skill is loaded
references/   scoped detail after SKILL.md chose the reference
```

Avoid opening `SKILL.md` or references with self-routing boilerplate such as
"Use this skill..." or "Use this reference...". Prefer ownership language in
`SKILL.md` ("Workspace API owns...") and scope language in references ("This
reference covers...").

Every reference link needs a concrete load condition in `SKILL.md`, for example:
"Read `references/api-errors.md` when the API returns a non-200 status."

Use `scripts/` only for repeated, deterministic, fragile, or error-prone work. Scripts should be documented in `SKILL.md`, non-interactive, retry-friendly, clear about prerequisites, structured on stdout, diagnostics on stderr, and bounded in output.

Use Bun by default in this repository. Translate upstream Agent Skills CLI examples from `npx skills ...` to `bun x --package skills skills ...`. For other npm package commands, preserve the package and use `bun x` or `bunx`, pinning versions when behavior must be reproducible.

## Evaluate A Skill

Do a lightweight eval when creating a new skill, changing trigger descriptions, or revising subtle behavior.

Escalate to [references/evaluation.md](references/evaluation.md) when the user asks to tune descriptions, compare versions, prove a skill works, audit an imported skill, or diagnose poor skill behavior.

Use this loop:

1. Include the motivating interaction and materially different requests that
   test whether its lesson transfers. Judge the resulting decisions, not
   resemblance to the approved example.
2. Compare against no skill for new skills, or the previous version for updates.
3. Use a clean context where possible.
4. Record failures, wasted steps, and missed project conventions.
5. Revise the description or core workflow first.
6. Move detail to references only when it is conditionally useful.

Two scripts make part of that loop mechanical:

```bash
bun run .agents/skills/agent-instructions/scripts/audit-skill-links.ts
bun run .agents/skills/agent-instructions/scripts/run-trigger-eval.ts
```

The first checks every Markdown link and heading anchor under `.agents/skills`;
nothing else in the repository does. The second runs a stored trigger corpus.
Its default pass is offline and reports what descriptions claim, which is a
smoke test on coverage and not evidence about routing; `--live` spawns the
Claude CLI per case to measure what a model actually loads.

Descriptions are not the only surface that routes. In the Claude Code probe used
here, `AGENTS.md` is present before descriptions are weighed and names skills
outright; a live A/B showed it decides the route for a broad phrase no
description claims. Editing it is a routing change with effects past the clause
you touched, so measure rather than reason about it.

Read [references/evaluation.md](references/evaluation.md) for trigger evals, always-on routing, execution trace review, and security checks.

## Validate With Vercel CLI

Validate discovery with the same path the CLI uses before installation:

```bash
bun x --package skills skills add /Users/braden/Code/epicenter/.agents/skills --list
```

For one skill, pass the source directory plus the skill name:

```bash
bun x --package skills skills add /Users/braden/Code/epicenter/.agents/skills --skill <skill-name> --list
```

The useful signal is:

```txt
Local path validated
Found N skill(s)
```

If the skill does not appear, fix `SKILL.md` and run the command again. When the current CLI supports it, use `skills use <source>` to forward-test a skill prompt without installing it.

Do not validate a local skill by passing the skill subdirectory itself. Current
CLI behavior validates that path but can report `No skills found`. For
`metadata.internal: true` skills, pass `--skill <name>` and confirm the named
skill appears in the listing.

## Update A Skill

Decide first whether the work updates this skill or becomes a new one, then,
beyond the edit itself:

- Re-read the description against realistic trigger and near-miss prompts. An
  update that changes what a skill does and leaves the description alone has
  moved the body out from under its own routing.
- Check whether linked `references/`, `scripts/`, or `assets/` still earn their
  keep, and delete what the update made dead.
- Remove local-only scaffolding the guidance has outgrown.
- Validate with [Validate With Vercel CLI](#validate-with-vercel-cli), and
  forward-test subtle behavior with realistic prompts.

When the user asks whether a skill needs changes, separate the answer into required fixes, worthwhile small improvements, and things to leave alone.

Use sharper review questions when the design still feels soft:

- What repeated failure does this prevent?
- Which future prompt should not trigger this?
- Which other skill should compose with this instead?
- What concrete run would prove this skill helped?

## Exit Gate

Everything above states a rule once. This lists only what has to be *checked*
before handing the skill over, and nothing already stated:

- `audit-skill-links.ts` reports no dead link or anchor.
- Validation passed with the Vercel `skills` CLI.
- Required tools are stated as prerequisites. A skill instructs an agent to use
  tools it already has; it does not grant access to apps, files, connectors, or
  credentials.
- No time-sensitive fact appears unless it is sourced and necessary.
- The `.claude/skills` symlink exists and is relative, or the skill is
  Codex-routed and deliberately has none.
- No orphan `CLAUDE.md` file was created; sibling shims only import `@AGENTS.md`.
- Punctuation follows `writing-voice`: no en dash characters, and em dash characters only when they earn the emphasis.
