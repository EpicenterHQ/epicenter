# Working-copy vision review, 2026-09-22

The user accepted executable `epicenter.config.ts` as the single local validation
input, with dependencies and ordinary execution failures. ADR-0420 records that
decision. ADRs0418, 0419, 0421, and 0422 now describe its consequences. ADR0125
retains its historical body and links the bounded runtime-write amendment.

Two fresh independent read-only Codex reviewers inspected the revised ADRs,
checkpoint report, definition compiler, draft CLI, field-diff helpers, legacy
checkout planner, store operations, and filesystem host. Both recommended keeping
the separation: config supplies interpretation, the manifest supplies captured
intent and destination, and the receiving owner supplies write authority.

The deletion prize is concrete: remove portable-schema admission and export,
generated-schema precedence and fingerprint checks, live-store conflict planning,
body rewriting, row creation/deletion through Push, and Push file writeback.
The baseline and durable unfinished marker remain necessary. A fresh-folder-only
workflow would avoid in-place refresh races but transfer recurring reconciliation
to the user; it does not satisfy the intended repeatable Git working folder.

## Findings incorporated

- The current KV handle only updates attributes. True deletion needs an ordinary
  store operation with persistence and replication evidence. Null is not deletion.
- Row existence checks must inspect raw identity, not typed visibility, so a
  nonconforming row can be repaired.
- Generated `agentsFile()` instructions still advertise body edits, row changes,
  whole-folder sweeping, and Push rewriting files. Replace them with the planner.
- Manifest paths do not by themselves prevent symlink escapes, alias-based lock
  bypasses, or editor races between checking and replacing a file. The durability
  wave must prove physical containment and preservation at replacement.
- A resolved persistence flush is insufficient; its status can still be blocked.
  Only demonstrated local durability permits successful baseline advancement.
- Imported config output and process exit qualify the structured-output promise.
  Ordinary console diagnostics belong on stderr; direct stdout writes and process
  termination remain trusted-code responsibilities. No isolated execution runtime
  is introduced just to control arbitrary config behavior.
- The validator does not open persistence; arbitrary imported code can. The ADR
  now states this execution boundary rather than promise control over all effects.
- Historical checkpoint claims about generated table contracts and write-schema
  admission no longer describe the target. Its opening update and remaining-work
  note identify them as historical.

These findings change implementation acceptance criteria, not the selected
product direction. The compiler's open JSON-schema escape retains upstream
semantics; no universal schema-linting guarantee or handwritten second dialect
is introduced.

## Execution checkpoints

1. Finish config-driven validation and delete the abandoned JSON compiler and
   meta-schema. Test actual imports, fresh invocations, failures, diagnostic
   framing, strict input parsing, KV presence, row normalization, and own writes.
2. Replace three-way planning with baseline preflight and receiving-owner
   permissions. Add true KV deletion, raw existence checks, and correct generated
   instructions. Do not expose mutations before durability is established.
3. Establish durable unfinished state, baseline ordering, canonical filesystem
   ownership, and preservation under concurrent editor writes. Fault-test actual
   boundaries; neither rename nor flush resolution alone proves the contract.
4. Connect one existing running owner and demonstrate Pull, script title edit,
   durable Push, unchanged second Push, and required refusal/reconciliation cases.

After each substantive wave, run two fresh read-only adversarial reviews of the
cumulative implementation and remaining plan. Keep the reviewed surface stable,
adjudicate against live evidence, repair and reverify, then reshape later waves.
Continue within the accepted outcome without repeating permission requests.
Commit shape follows coherent review units, not a mandatory one-wave-one-commit
rule. Generation removal, native storage, independent openers, shared membership,
SQL, Matter UI, and definition-package distribution remain separate work.

## Verification boundary

This was an ADR and handoff turn; no implementation was changed. Reviewers ran
source inspections, not runtime tests. Scoped documentation diff checking passed.
The repository documentation checker reports 64 ADR status/dependency issues;
this turn did not perform broad status cleanup or establish their task-start
attribution. Config loading and the real owner workflow remain unbuilt.

The self-contained implementation prompt is saved at
`/tmp/epicenter-config-execution-handoff.md`. That temporary file contains the
dirty-work inventory, abandoned draft paths, verification commands, and explicit
completion condition. The durable decisions and checkpoint requirements are in
the ADRs and this report.
