# Skill Evaluation

Load this when tuning description routing, comparing skill versions, diagnosing why an agent used a skill poorly, or checking the source guidance behind this skill.

## Table Of Contents

- [Source Links](#source-links)
- [Authority Split](#authority-split)
- [Prompt Set](#prompt-set)
- [Baseline](#baseline)
- [Assertions](#assertions)
- [Output Quality Eval](#output-quality-eval)
- [Skill Content Checklist](#skill-content-checklist)
- [Script Requirements](#script-requirements)
- [Failure Modes](#failure-modes)
- [Concrete Examples](#concrete-examples)
- [Execution Trace Review](#execution-trace-review)
- [Iteration Loop](#iteration-loop)
- [Security And Portability](#security-and-portability)

## Source Links

- Agent Skills overview: https://agentskills.io/home
- Agent Skills best practices: https://agentskills.io/skill-creation/best-practices
- Optimizing skill descriptions: https://agentskills.io/skill-creation/optimizing-descriptions
- Evaluating skills: https://agentskills.io/skill-creation/evaluating-skills
- Using scripts in skills: https://agentskills.io/skill-creation/using-scripts
- Anthropic engineering post: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Vercel Agent Skills docs: https://vercel.com/docs/agent-resources/skills
- Vercel skills CLI README: https://github.com/vercel-labs/skills/blob/main/README.md
- Matt Pocock skills repo: https://github.com/mattpocock/skills
- Matt Pocock write-a-skill: https://github.com/mattpocock/skills/blob/main/skills/productivity/write-a-skill/SKILL.md
- OpenAI Academy skills resource: https://academy.openai.com/public/resources/skills

## Authority Split

- Vercel `skills` CLI: accepted frontmatter, discovery paths, install behavior, and compatibility checks.
- Agent Skills docs: authoring, progressive disclosure, eval, and script design guidance.
- OpenAI Academy: portability, playbook shape, sharing, connector, and workspace permission behavior.
- Matt Pocock skills: practical examples and taste calibration, not the format source of truth.

## Prompt Set

Start small:

- 2 or 3 prompts that should trigger the skill.
- 1 or 2 near-miss prompts that share vocabulary but should not trigger it.
- Varied styles: casual, precise, incomplete, and edge-case phrasing.

For serious trigger tuning, aim for about 20 prompts: 8 to 10 that should trigger and 8 to 10 that should not. Keep separate train and validation examples. Revise from the train set, then choose the best description by validation behavior.

Run each prompt multiple times when possible, commonly 3 runs, because routing can vary. Track trigger rate instead of trusting one run. Stop early only when the outcome is already clear. After applying the selected description, sanity-check with 5 to 10 fresh prompts.

## Baseline

Compare against the right baseline:

- New skill: compare against no skill.
- Existing skill: compare against the previous skill version.
- Description-only change: compare routing behavior before and after the edit.

Use clean contexts when possible. Do not tell the evaluating agent the expected answer.

## Assertions

Use assertions only when they can be checked with evidence:

- Discovery assertion: the skill appeared in CLI listing.
- Routing assertion: the skill triggered or did not trigger for the prompt.
- Output shape assertion: required sections, files, fields, or commands exist.
- Policy assertion: required or forbidden project conventions were followed.
- Mechanical assertion: a script or command can verify the result.

Avoid brittle phrase matching. Assertions should check outcomes, not exact wording.

## Output Quality Eval

Use this structure when the user asks to prove a skill works or compare versions:

```txt
evals/
|-- evals.json          prompt, expected_output, optional files
|-- files/              input files for eval cases
`-- runs/
    `-- iteration-1/
        |-- case-id/
        |   |-- with_skill/
        |   `-- without_skill/
        |-- grading.json
        |-- timing.json
        `-- benchmark.json
```

Run each case against the right baseline: no skill for a new skill, previous version for an update. Capture outputs, transcripts, token counts, and duration when available. Grade with concrete evidence, aggregate pass rates, compare deltas, and inspect assertions that always pass, always fail, or vary between runs.

Human feedback still matters. Save concise notes when the output is technically valid but unhelpful, overbroad, or not in the user's voice.

## Skill Content Checklist

Before expanding a draft, confirm the skill states:

- Job to be done.
- Required inputs or prerequisites.
- Ordered workflow.
- Output format or final artifact.
- Guardrails and forbidden actions.
- Final checks.

Classify the skill as a process, tool workflow, convention, or domain pattern. If one skill needs multiple classifications with different trigger situations, consider splitting it.

## Script Requirements

Use scripts when repeated code execution is more reliable than asking the agent to recreate the logic each time. Good candidates include validators, parsers, format converters, scaffolding, or output summarizers.

Scripts should be:

- Referenced with paths relative to the skill directory.
- Listed in `SKILL.md` before the agent needs them.
- Self-contained when practical.
- Non-interactive, with input through flags, environment variables, stdin, or files.
- Equipped with concise `--help` output.
- Structured on stdout, with diagnostics on stderr.
- Clear about exit codes.
- Idempotent or dry-run capable when changing files or external state.
- Bounded in output, with full output written to a file when needed.

In this repository, prefer `bun`, `bun run`, and `bun x`. Pin versions when command behavior must be reproducible.

Do not rely blindly on Bun inline dependency auto-install behavior inside this monorepo. Existing parent `node_modules` directories can change whether inline imports auto-install. State prerequisites or use explicit workspace dependencies when needed.

## Failure Modes

| Symptom | Likely Cause | Correction | Re-test |
| --- | --- | --- | --- |
| Skill does not trigger | Description misses user intent | Rewrite description around task phrasing and file/tool cues | Run should-trigger prompts 3 times |
| Skill overfires | Description is too broad | Add near-miss boundaries and remove generic trigger language | Run should-not-trigger prompts |
| Agent ignores reference | Load condition is vague | Replace "see references" with "read X when Y happens" | Re-run the prompt that needed the reference |
| CLI validation fails | Frontmatter or discovery shape is invalid | Fix `name`, `description`, path, or unsupported metadata | Run the source-directory command from `SKILL.md`; add `--skill <name>` for an individual or internal skill |
| Imported skill conflicts with AGENTS.md | Upstream guidance assumes different repo rules | Keep local AGENTS.md rules and adapt or reject the skill | Re-run local review checklist |
| Source example uses `npx` | Upstream command is not Bun-adapted | Use `bun x --package skills skills ...` for skills CLI, or preserve package with `bun x`/`bunx` for other tools | Run command help or dry-run |

## Concrete Examples

Should trigger `agent-instructions`:

- "Write a skill for reviewing Svelte accessibility in this repo."
- "Improve the data-lens skill description so it triggers less often."
- "Should this AGENTS.md rule become a skill or stay global?"

Should not trigger `agent-instructions`:

- "Install the TypeScript skill globally."
- "Write a README for the auth package."
- "Commit the current staged changes."

Imported-skill audit prompt:

```txt
Audit this third-party skill before adapting it to Epicenter. Check frontmatter,
scripts, network assumptions, npx commands, unsupported metadata, and conflicts
with AGENTS.md.
```

Small good skill shape:

```md
---
name: svelte-accessibility-review
description: Review Epicenter Svelte UI for accessibility and interaction issues. Use when reviewing `.svelte` UI, keyboard behavior, focus states, labels, or @epicenter/ui composition.
---

# Svelte Accessibility Review

Use `@epicenter/ui` components before custom controls.

Workflow:
1. Read the changed `.svelte` files.
2. Check keyboard access, focus order, labels, disabled states, and loading states.
3. Verify text does not overlap or rely on color alone.
4. Report findings first with file links.

Read `references/dialogs.md` when the change touches modal or popover focus.
```

## Execution Trace Review

Read traces and intermediate notes when behavior is subtle. Look for:

- What the agent loaded.
- What it ignored.
- Where it hesitated or explored unproductive paths.
- Where the skill caused overuse or false positives.
- Where it missed a project convention.
- Which instruction was too vague, too broad, or not needed.

If the agent already handles the task well without the skill, cut the skill or narrow it.

## Iteration Loop

1. Run realistic prompts.
2. Record failures and wasted steps.
3. Group repeated patterns.
4. Revise the description first when routing is wrong.
5. Revise the core workflow when execution is wrong.
6. Move detail to `references/` only when it is conditionally useful.
7. Use scripts for deterministic checks when code can verify better than prose.
8. Re-run validation prompts.
9. Keep the version with the best validation behavior, even when it is not the latest draft.

Do not add exhaustive rules to chase one failed prompt. Generalize only from repeated failures or clear project constraints.

## Security And Portability

Audit imported or copied skills before installing or adapting them:

- Read `SKILL.md` and every linked file.
- Inspect scripts, dependencies, bundled assets, and templates.
- Look for hidden network assumptions or instructions that contact external services.
- State required tools as prerequisites. A skill does not grant access to apps, files, connectors, or credentials.
- Skills can only instruct agents to use tools and connectors already available under current permissions and organization controls.
- Avoid ChatGPT-only, Claude-only, or Codex-only behavior unless the user explicitly targets that tool.
- When installing skills across agents, prefer symlink installs so there is one source of truth. Use copy mode only when symlinks are impossible, and verify installed state with `skills list` when installation is part of the task.
- Prefer Vercel CLI behavior over local validators.

Keep repository skills portable. Do not add `agents/openai.yaml`, local validator scripts, generated OpenAI YAML, decorative assets, or unsupported metadata as part of the standard shape.
