---
name: agent-instructions
description: Create, revise, place, audit, evaluate, and validate repository agent instructions across AGENTS.md, CLAUDE.md, and `.agents/skills`. Use when adding or moving agent rules, deciding whether guidance belongs globally or in a skill or reference, writing or improving a skill, tuning routing descriptions, validating discovery, or reviewing instruction sprawl and composition.
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

- `writing-voice`: user-facing prose, UI text, errors, docs, and tone.
- Domain skills such as `data-lens`, `svelte`, or `auth`: package conventions the new skill must encode.
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

## What Not To Add

Keep repository skills portable and boring. Do not add these as part of the standard:

```txt
agents/openai.yaml
scripts/init_skill.py
scripts/quick_validate.py
scripts/generate_openai_yaml.py
references/openai_yaml.md
decorative assets
```

Those can exist in personal or system skill installations, but they are not the Vercel-backed skill format.

## Create A Skill

Default to project-local skills:

```bash
cd /Users/braden/Code/epicenter/.agents/skills
bun x --package skills skills init <skill-name>
```

Then edit `.agents/skills/<skill-name>/SKILL.md` directly.

Before drafting body content:

1. Classify the skill as `process`, `tool workflow`, `convention`, or `domain pattern`.
2. Gather real source material: completed tasks, diffs, review comments, issue threads, runbooks, execution traces, and repeated corrections.
3. Confirm the task, target users, trigger use cases, supporting references, and whether any repeated fragile work needs a script.
4. If those answers are missing and cannot be discovered from repo files, ask before drafting.
5. Write the description before expanding body content.
6. Ensure the draft states the job to be done, required inputs or prerequisites, ordered workflow, output format, guardrails, and final checks.
7. Keep the core workflow small and move conditional detail to `references/`.

## Write The Description First

The description is always loaded and drives selection. It must carry the trigger logic because the body is loaded only after the skill is selected.

Do not add body sections like `When to apply this skill`, `When to load`, `Trigger phrases`, or `Use this skill when...`. By the time the body is read, routing already happened. Put routing in the frontmatter description; use the body for workflow, guardrails, examples, and final checks.

Include:

1. What the skill does.
2. Concrete situations that should trigger it.
3. Important file types, packages, tools, or phrases the user might mention.

Use `Use when...` phrasing. Describe user intent, not implementation mechanics. Keep the description concise and under the 1024 character limit.

Good:

```yaml
description: Data Lens patterns for defineLens, defineTable, defineValues, typed binding, documents, and blobs. Use when defining app record schemas, reading or writing Lens data, handling nonconforming records, or choosing a record lane.
```

Weak:

```yaml
description: Helps with workspace stuff.
```

For subtle routing, test 2 or 3 should-trigger prompts and 1 or 2 near-miss should-not-trigger prompts. Do not stuff exact keywords unless the keyword represents a real trigger category.

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
`SKILL.md` ("Data Lens owns...") and scope language in references ("This
reference covers...").

Every reference link needs a concrete load condition in `SKILL.md`, for example:
"Read `references/api-errors.md` when the API returns a non-200 status."

Use `scripts/` only for repeated, deterministic, fragile, or error-prone work. Scripts should be documented in `SKILL.md`, non-interactive, retry-friendly, clear about prerequisites, structured on stdout, diagnostics on stderr, and bounded in output.

Use Bun by default in this repository. Translate upstream Agent Skills CLI examples from `npx skills ...` to `bun x --package skills skills ...`. For other npm package commands, preserve the package and use `bun x` or `bunx`, pinning versions when behavior must be reproducible.

Calibrate control to fragility. Be prescriptive for exact commands, migrations, destructive operations, and brittle formats. For batch, destructive, external-state, or high-blast-radius operations, use plan-validate-execute: create the plan, validate it against the source of truth, then execute. For judgment-heavy reviews or design work, give defaults and decision rules rather than rigid scripts.

## Evaluate A Skill

Do a lightweight eval when creating a new skill, changing trigger descriptions, or revising subtle behavior.

Escalate to [references/evaluation.md](references/evaluation.md) when the user asks to tune descriptions, compare versions, prove a skill works, audit an imported skill, or diagnose poor skill behavior.

Use this loop:

1. Start with 2 or 3 realistic prompts.
2. Compare against no skill for new skills, or the previous version for updates.
3. Use a clean context where possible.
4. Record failures, wasted steps, and missed project conventions.
5. Revise the description or core workflow first.
6. Move detail to references only when it is conditionally useful.

Read [references/evaluation.md](references/evaluation.md) for trigger evals, execution trace review, and security checks.

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

When updating an existing skill:

1. Read the current `SKILL.md`.
2. Decide whether this should update the existing skill or become a new skill.
3. Check whether linked `references/`, `scripts/`, or `assets/` still earn their keep.
4. Review the description against realistic trigger and near-miss prompts.
5. Remove stale local-only scaffolding from the guidance.
6. Validate with the commands in [Validate With Vercel CLI](#validate-with-vercel-cli).
7. Forward-test subtle behavior with realistic prompts.

When the user asks whether a skill needs changes, separate the answer into required fixes, worthwhile small improvements, and things to leave alone.

Ask draft review questions when the scope is uncertain: does this cover the target use cases, is anything missing, and should any section move to `references/`?

Use sharper review questions when the design still feels soft:

- What repeated failure does this prevent?
- Which future prompt should not trigger this?
- Which other skill should compose with this instead?
- What concrete run would prove this skill helped?

## Review Checklist

- The description has concrete triggers and near-miss boundaries.
- `SKILL.md` contains the core workflow, not a copied source essay.
- References have clear load conditions.
- Scripts are justified, non-interactive, and portable.
- Required tools are stated as prerequisites; the skill does not imply access to apps, files, connectors, or credentials.
- Optional frontmatter is intentional: keep cross-agent fields like `license`,
  `argument-hint`, `disable-model-invocation`, and useful `metadata`; avoid
  agent-specific execution-control fields unless the target agent supports
  them.
- The skill avoids time-sensitive facts unless sourced and necessary.
- No orphan `CLAUDE.md` files are created; sibling shims only import `@AGENTS.md`.
- Punctuation follows `writing-voice`: no en dash characters, and em dash characters only when they earn the emphasis.
- Validation passed with the Vercel `skills` CLI.
