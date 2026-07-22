# Composition Audit

Load this when stress-testing how a *cluster* of skills composes, not a single skill:
routing collisions, duplicated bodies, dead links, and unclear roles. Run it
after extracting or merging a skill, after adding a description trigger, or on a
cadence over a named cluster (for example the review/simplify cluster:
`post-implementation-review`, `collapse-pass`, `fresh-context-review`,
`greenfield-clean-breaks`, `radical-options`, `asymmetric-wins`,
`first-read-review`, `one-sentence-test`).

This complements, does not replace:

- `references/evaluation.md` owns single-skill trigger evals and traces.
- `references/instruction-placement.md` owns placement (AGENTS.md vs skill vs
  reference vs delete) for one instruction.
- This file owns the *system* view: do these skills route cleanly and avoid
  re-teaching each other's bodies.

## Role Model

Classify every skill in the cluster as exactly one role. A skill that cannot pick
one is the finding.

```txt
hub        orchestrates an ordered pass, delegates moves   (post-implementation-review, collapse-pass)
move       one named cognitive step, triggered by a phrase (one-sentence-test, asymmetric-wins)
mechanic   reusable per-change craft other skills cite     (refactoring, typescript, code-audit)
adapter    thin wrapper adding inputs/IO to another skill   (rare; fold into the base skill unless the IO is substantial)
```

A move should own its phrase and delegate execution. A hub should not inline a
move's full body. A mechanic should be cited, not copied. If two skills claim the
same role for the same surface, one of them is redundant.

## Mechanical Detectors

Run these from `.agents/skills`. They are cheap; run them every pass. Each one
maps to a failure I have actually shipped.

### 1. Routing collision (the headline check)

For each phrase you say out loud as a trigger, exactly one description should
claim it. More than one is an over-trigger.

```bash
bun run agent-instructions/scripts/audit-routing-collisions.ts "asymmetric wins"
```

The script searches only the `description` field in each skill's frontmatter.
Exactly one hit = clean routing. Zero hits = no owner. Two or more hits =
collision. Fix by narrowing every description except the one true owner: do not
let a hub or manual *open* with a move's name. (This check catches the case where
a manual was branded "Asymmetric-wins pass" while a dedicated `asymmetric-wins`
move also existed.)

### 2. Duplicated bodies

Same `## Heading` living in many skills usually means a copied essay.

```bash
grep -rh '^## ' */SKILL.md | sed 's/^## //' | sort | uniq -c | sort -rn | awk '$1>1'
```

Ignore structural repeats (`Output Shape`, `References`, `Compose With`). Treat
content repeats (`Mental Inlining Pass`, `Asymmetric Wins Pass`,
`Go-to-Definition Awareness`) as candidates to collapse into one owner that the
rest link to.

This detector counts headings, not bodies, so it stays red after a correct
collapse: the heading survives in every skill, but only the owner keeps the
essay and the rest become one-paragraph pointers (`run X "Pass"`). Before
treating a repeat as a finding, open each section and confirm whether the
non-owners already delegate. A delegating repeat is resolved, not a smell.

### 3. Dead and orphan links

```bash
# broken reference links: match real markdown links ](...) only, keep the
# ../skill/ prefix, and resolve relative to the linking file's dir. Matching the
# bare `references/x.md` tail (and dropping the prefix) gives false DEAD hits for
# valid cross-skill links like ](../data-lens/references/x.md) and for
# backtick-wrapped prose like `references/api-errors.md`.
grep -rnoE '\]\((\.\./[a-z0-9-]+/)*references/[a-z0-9-]+\.md\)' */SKILL.md | while IFS=: read -r f n match; do
  link="${match#']('}"; link="${link%')'}"
  [ -f "$(dirname "$f")/$link" ] || echo "DEAD REF: $f:$n -> $link"
done
# broken ../skill/SKILL.md cross-links
grep -rho '\.\./[a-z0-9-]*/SKILL\.md' */SKILL.md | sort -u | while read -r l; do
  [ -f "${l#../}" ] || echo "DEAD LINK: $l"
done
# skill dirs missing a SKILL.md (stubs/orphans)
for d in */; do [ -f "${d}SKILL.md" ] || echo "NO SKILL.md: $d"; done
```

### 4. Inbound-link count (coupling)

```bash
for s in $(ls -d */ | sed 's#/##'); do
  c=$(grep -rl "\.\./$s/SKILL\.md" */SKILL.md | grep -v "^$s/" | wc -l | tr -d ' ')
  printf '%3d  %s\n' "$c" "$s"
done | sort -n
```

Read the result by role: a `hub` with 0 inbound links is fine (it is a front
door). A `move` with 0 inbound is suspicious (nothing delegates to it: is its
phrase real?). A `move` with exactly 1 inbound is tightly coupled (could it just
be a section of that one caller?). Many inbound = a healthy shared move.

### 5. Description-restatement body section

A full-library audit found ~40 skills opening with a "When to Apply This Skill"
list that restates the frontmatter description bullet for bullet. By the time
the body loads, routing already happened; the copy only costs tokens and drifts.

```bash
grep -ln '^## When [Tt]o Apply' */SKILL.md
```

Open each hit and diff its bullets against the description. Pure restatement =
delete the section. Keep it only when it adds recognition cues the description
cannot carry (concrete code smells, near-miss boundaries).

### 6. Restating closer

A closing "Quick Reference", "Checklist", "Best Practices", "Common Gotchas",
"Anti-Patterns", or "Complete Example" that restates the body item for item.
Two copies of one rule drift to different calibrations (technical-articles
shipped "max 3-4 sentences" in the body and "4-5" in its closer).

```bash
grep -nE '^#{2,3} (Quick Reference|.*Checklist|Best Practices|Anti-[Pp]atterns|Common (Gotchas|Mistakes|Pitfalls)|Complete .*Example|Final Check|What to Avoid)' */SKILL.md
```

For each closer item, find the section above that owns it; delete owned items
and keep only rules stated nowhere else. An exit gate that verifies earlier
artifacts (grep the debug prefix, re-run the repro) is not a restatement; keep it.

### 7. Transcript and import residue

Sections harvested from the one conversation (or upstream repo) that spawned
them: version literals, PR numbers, spec paths (specs are deleted when done, so
the links dangle by construction), "not yet"/"currently" state snapshots, and
other-framework examples in a Bun + Hono + Svelte repo.

```bash
grep -rnE 'v[0-9]+\.[0-9]+\.[0-9]+|PR #[0-9]+|specs/[0-9]{8}T[0-9]{6}|not yet|[Cc]urrently' */SKILL.md
grep -rnE 'Next\.js|React Router|react-|from "react|Prisma' */SKILL.md
```

Version, PR, and spec hits inside teaching examples become placeholders or a
two-line "the pattern converged on X" summary. Framework hits are import
residue unless the skill is explicitly about that framework.

### 8. Dash-strip damage

A past mechanical em dash removal left floating colons (" : ") and glued text
("works:WHY", "):that") across 8+ skills, so the dash grep reads clean while
the prose is broken.

```bash
grep -rnE ' : |\):[a-z]|[a-z]:[A-Z][A-Z]' */SKILL.md
```

Replace with a real colon, semicolon, comma, or sentence break per
writing-voice. Ternaries and conditional types in fenced code also match
" : ", so skim each hit's context before editing; only prose hits are
findings.

### 9. Everyday-ask triggers

A description claiming a phrase people say constantly in conversations that
should not load the skill ("be brief", "what should we do", "simplify this",
"can you summarize", "what does X do"). Worst when the skill is sticky or
heavyweight: caveman's persistent persona fired on a one-off "be brief".

```bash
# scan the whole frontmatter: descriptions can be block scalars spanning lines
for d in */SKILL.md; do awk '/^---$/{n++} n==1' "$d"; done | grep -oE '"[^"]{2,40}"' | sort | uniq -c | sort -rn
```

For each quoted phrase ask: would this phrase occur in a conversation where
loading the skill is wrong? If yes, narrow the phrase ("summarize what we
did") or add a near-miss clause ("for a plain code question, answer directly").

## Judgment Pass

After the mechanical pass, ask the agent-instructions questions per skill, then two
cluster questions the single-skill eval cannot see:

```txt
Per skill (from agent-instructions):
  What repeated failure does this prevent?
  Which spoken phrase should trigger it?
  Which near-miss phrase must not?
  Does it own a workflow, or only a lens already owned elsewhere?

Per cluster:
  If I say each trigger phrase, does exactly one skill answer? (run detector 1)
  Does any hub re-teach a move's body instead of delegating? (run detector 2)
```

When a collision or a near-miss is in doubt, escalate to
`references/evaluation.md`: run the 2-3 should-trigger and 1-2 should-not prompts
three times each and track the trigger rate. Do not trust one run.

## Output Shape

```txt
Cluster: <name> (<N> skills)

Roles
  skill            role      owns
  asymmetric-wins  move      "asymmetric wins" phrase + refusal template

Collisions
  "<phrase>" claimed by: <skill A>, <skill B>   -> narrow <B>

Duplicated bodies
  "<heading>" in <skills>   -> single owner <skill>, others link

Dead/orphan
  <findings or none>

Verdict
  keep / narrow / merge / demote, one concrete reason each
```

## Run It Continuously

This is a reflection loop, not a one-shot. Two cadences:

- Event-driven: run detectors 1-3 immediately after any extract, merge, rename,
  or description edit in the cluster. They are seconds to run and catch the
  collision before it ships.
- Periodic: self-paced sweep of one cluster, fix or file each finding, stop when
  a pass yields nothing new.

A self-paced loop invocation:

```txt
/loop Audit the review/simplify skill cluster for composition health.
Load agent-instructions and read references/composition-audit.md. Run detectors 1-9,
then the judgment pass. Report findings in the output shape and fix only
mechanical, grounded ones (collisions, dead links, copied bodies). Escalate
ambiguous triggers to references/evaluation.md. Stop when a full pass finds
nothing new.
```

Let the loop self-pace: there is no external state to poll, so re-run only when
the cluster changes, not on a timer.
