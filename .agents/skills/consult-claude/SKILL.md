---
name: consult-claude
description: Give Claude one fresh, read-only, source-grounded adversarial memo on Codex's synthesis. Use when the user asks Codex to consult Claude or when an independent investigation would materially reduce risk in a high-stakes, ambiguous, architectural, product, planning, or clean-break decision; Codex may invoke it autonomously after forming an evidence-backed read. Do not use for implementation, an obvious bounded decision, or a continuing Claude conversation.
---

# Consult Claude

Consult Claude gives one fresh reasoning trajectory enough read access to
investigate and attack Codex's grounded synthesis. The user owns product
direction. Codex owns the initial investigation, DeepWiki preflight, packet
curation, reconciliation, and final recommendation. Claude owns the independent
follow-up investigation and one evidence-backed adversarial memo. The runner
enforces a bounded lifetime and exposes no mutation tools.

Codex may escalate autonomously when getting the judgment wrong would cost
substantially more than the additional latency and quota. Announce the
consultation and why it earns the escalation before starting it. Do not consult
to avoid forming a grounded position first.

## Ground every consultation

Before building the packet, inspect the subject and identify every materially
relevant public GitHub repository. Attempt a narrow DeepWiki question against
each one. If no repository is relevant, record that explicitly. If DeepWiki is
unavailable or a repository is not indexed, record the failed attempt and use
upstream source or official documentation instead; provider availability never
blocks the consultation.

Treat DeepWiki as orientation, not final authority. Verify every decisive claim
against installed types, local or upstream source, tests, or official docs.
Preserve contradictions and unverified claims as open investigation questions
instead of smoothing them into Codex's conclusion.

Curate the results thoughtfully. For each relevant repository, keep the exact
question, concise findings, provenance, verification, and unresolved points
that bear on the decision. Do not paste raw DeepWiki responses or include
findings merely because they were returned.

Read enough repo-local evidence to make Codex's working model explicit before
consulting. Give Claude the sources and conversation history that explain how
the working model evolved, but do not close the record around Codex's evidence
selection. When consulting inside a dialectic, include the live shared model
and how the working model and user's ideal came into contact. Preserve verbatim
user reactions when summarizing them would flatten the user's taste.

## Build the packet

Start every packet with this mandate:

```txt
Mandate:
  Attack the synthesis as a whole. Surface inherited assumptions and hidden
  compromises, articulate the strongest rival, test the important failure
  modes, and recommend the best direction. Propose collapse or a clean break
  when the evidence earns it, not as a default.

  Treat the supplied evidence as a grounded starting point, not a closed
  record. Inspect relevant repository sources and authoritative documentation
  when doing so could verify, falsify, or materially improve the synthesis.
  Use DeepWiki for focused follow-up questions when external library behavior
  matters. You may identify and query additional relevant GitHub repositories;
  explain why each new repository could change the recommendation. Treat
  DeepWiki as orientation and verify decisive claims against installed types,
  source, tests, or official documentation.

  Report consequential discoveries with precise source locations. Distinguish
  supplied evidence, newly discovered evidence, and interpretation. Preserve
  material disagreement between sources.

  Return one decisive memo. Do not edit files, run mutating operations, ask the
  user questions, implement, or continue the task.
```

Then make the packet cold-start complete:

```txt
Mission:
  The bounded subject or design problem.

Evolution:
  How the working model changed. When a dialectic is active, how the live
  shared model changed.

User ideal and divergences:
  Selected questions, reactions, rejected framings, and recognition criteria
  when they are part of the originating conversation.

Starting evidence:
  Established excerpts, diffs, command output, paths, and durable decisions.
  Include decisive context directly and name sources Claude should inspect.

External grounding:
  For every materially relevant GitHub repository: repository name, exact
  DeepWiki question, concise relevant findings, provenance, verification, and
  unresolved or conflicting claims. Record when no repository is relevant or
  when a DeepWiki attempt failed and which fallback source replaced it.

Working model:
  Codex's explicit grounded model and the path from evidence to its conclusions
  or proposal.

Strongest rival:
  The best competing vision or objection Codex can already articulate.

Investigation questions:
  Facts, assumptions, source disagreements, and architectural boundaries that
  remain open to attack.

Constraints:
  Product promises, ownership boundaries, security limits, and refusals.

Deliverable:
  The memo shape that will help Codex reconcile the challenge.

Stop:
  Answer this bounded problem. Do not implement or expand the task.
```

Give Claude relevance-complete direction, not a conclusion-only summary or a
repository dump. Point it at the strongest starting sources so investigation
can follow consequential leads instead of repeating Codex's entire discovery
pass.

## Run one read-only investigation

Prerequisites: Bun and a current, authenticated Claude CLI on macOS or Linux.
Resolve this skill's directory from its loaded `SKILL.md` path. Start
`scripts/consult-claude.ts` in the task's working directory with a PTY and keep
the returned command session attached. The runner switches terminal input to
raw, non-echoing mode. Write the complete packet to stdin, then send the EOT
character (`Ctrl-D`). The runner accepts no prompt arguments and creates no
repository files.

The runner starts one high-effort Claude turn from an empty temporary directory
and grants read access to the task directory. Claude Code does not load project
instructions from an added directory by default. The runner loads no user,
project, or local settings; disables slash commands, Chrome, and session
persistence; and supplies one strict MCP configuration containing only
DeepWiki. Gmail, Drive, Calendar, Epicenter, configured MCP servers, and future
MCP additions are unavailable.

Claude may read and search files, run shell commands that Claude Code recognizes
as read-only, consult public web sources, and call
`mcp__deepwiki__ask_question`. No file-editing tool is present. DeepWiki and
public web research are explicitly approved; other operations that require
permission cannot receive an unattended approval.

Read-only protects repository integrity, not confidentiality. Sending the
packet and running tools exports their relevant contents to the locally
authenticated Claude and DeepWiki providers. Keep investigation inside the
task's repository and subject. Do not direct Claude into credentials,
environment files, personal data, unrelated private material, or broader
external systems. Ask the user before crossing that boundary. If the runtime
blocks required in-scope access, do not silently weaken the investigation;
explain the boundary.

## Wait patiently

- Keep the returned command session attached and poll that same session.
- Treat silence as slow, not hung; the runner emits a heartbeat every minute.
- Update the user at least once per minute with elapsed time.
- Continue through provider retries and rate limits.
- Never launch a duplicate because the consultation is quiet.
- Cancel when the user changes direction or the consultation is no longer
  relevant. Let the runner terminate the process group after 30 minutes.

Do not add detached jobs, status files, session resume, or lifecycle commands.
Codex's command session already owns waiting and cancellation.

## Reconcile the memo

1. State Claude's strongest recommendation accurately.
2. Separate starting evidence, Codex's external grounding, Claude's newly
   discovered evidence, and opinion.
3. Verify every material discovery against local files or authoritative
   sources.
4. Preserve unresolved source disagreements instead of choosing by confidence.
5. State where Codex agrees, disagrees, or needs more evidence.
6. Resolve obvious evidence-dominated consequences without ceremony.
7. Bring genuine product, promise, ownership, or taste forks to the user.
8. Return Claude's challenge to the originating workflow. When a dialectic is
   active, put it back into the live shared model and continue the conversation.

Do not smooth genuine disagreement into a compromise. When a product decision
remains, present Claude's recommendation, Codex's read, and the concrete choice
the user owns.

Each consultation is fresh. A later checkpoint may request another consultation
for a genuinely new synthesis, but never resume a Claude session or let Claude
accumulate hidden context.
