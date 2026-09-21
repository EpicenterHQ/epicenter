# Working-copy parser and schema checkpoint

The parser and field-diff primitives are implemented. The legacy checkout still
uses its earlier mutation policy; the new helpers are not connected to Push.
This checkpoint does not establish that the app or CLI workflow is ready.

## Verified behavior

- Epicenter artifacts use Matter's YAML reader and retain a JSON-value boundary.
- Malformed YAML, duplicate keys, explicit top-level null, and non-JSON values
  refuse instead of producing partial fields.
- Matter preserves a fenced empty mapping when its last field is cleared.
- Field comparison ignores object key order. Absent and null top-level fields
  compare equally; removing a populated nullable field produces a clear.
- Only changed fields are checked against owner permissions and their declared
  value constraints. Untouched nonconforming values remain untouched.
- All 13 field kinds map to Matter's recognized value schemas. Nullable fields
  become optional. Reserved SQL columns and case-insensitive collisions refuse.

Verification: 351 artifact and Matter tests pass, including actual Matter
serializer round trips. App data and Matter TypeScript checks pass. Another 10
definition tests pass. The independent Codex follow-up reran 42 focused tests.
Both reviewers found no remaining blockers in the repaired parser/schema scope.
An additional serializer regression test covers body-only edits gaining an
empty fence while preserving their body text.

## Independent review

Codex and Claude Fable reviewed the cumulative changes and the next recovery
boundary. Their findings led to regression fixes for explicit YAML null,
clearing the last field, inherited property names, and column collisions.

Both preferred ordinary edits through the existing live store over preparing
Yjs updates in a temporary clone. Replaying fixed update bytes is idempotent,
but creating them before filesystem I/O changes same-field ordering and adds
causal-dependency and byte-admission work.

## Decision after the conceptual review

Keep ordinary Markdown editing and folder-held comparison baselines. Refuse
automatic recovery of ambiguous submissions. An unfinished-operation marker
blocks normal Pull/Push until the person reconciles preserved edits with a
fresh Pull, after establishing that the old operation cannot still execute.
ADR-0418 records the ordering and user obligations.

The earlier owner-held digest/receipt proposal is withdrawn. No checkout
records need to be added to SQLite or IndexedDB update transactions. Clearing
an app cache alone does not invalidate a folder baseline if the same remote
document survives. Whole-document replacement is a separate operator-owned
operation; it requires discarding old replicas and starting fresh checkouts.

## Remaining work

1. Replace the legacy checkout planner with complete preflight and permitted
   field patches. Remove body replacement, row creation/deletion, resurrection,
   and live-store conflict planning. Push advances captured baseline metadata
   only; remove its touched-row rendering and whole-folder writeback.
2. Implement durable unfinished-operation handling around both Push and Pull.
   Fault-test delayed owner completion, failed persistence, folder edits during
   submission, and partial materialization. Prove uncertain operations refuse
   blind retry and preserve files for reconciliation. A resolved `flush()` is
   insufficient: check durability status. Distinguish unreadable directories
   from absent ones. Verify external edits during Pull are preserved or refused;
   the current host request queue does not exclude ordinary editors.
3. Run an adversarial checkpoint before integrating the identified running
   owner and CLI. Keep account/destination checks and refuse if unavailable.
4. Review the complete workflow before claiming app or CLI readiness.

Generation removal, native persistence migration, shared membership, and
headless provisioning remain separate work. No automatic replacement workflow
or restore-through-Push mode is planned.

## Freshness review

Do not require Pull before Push or add a remote freshness barrier. Pull refreshes
a clean folder from the owner's observed state. Push applies changed-field
assignments from the existing baseline. Same-field conflicts and unseen remote
deletions retain ordinary CRDT semantics. Refresh context before edits whose
meaning depends on current values or a current query result.

One fresh independent Codex reviewer and a local complementary pass reviewed
this boundary. A second fresh reviewer could not start because the session's
agent-thread limit was reached. No runtime behavior was changed by this review.

## Git layout decision

ADR-0422 defines the Git boundary: version row Markdown, table contracts, KV,
and working-copy instructions; keep the manifest, interruption state, and optional
`query.sqlite` under the ignored `.epicenter/` directory. The index is disposable;
the manifest is not. Clones without local metadata remain readable but refuse
Push, and Pull must preserve existing cloned content.

Before claiming Git compatibility, replace suffix-based host file ownership
with explicit managed paths, preserve existing ignore rules, and test ordinary
commits, historical file checkouts, and independent worktrees. Standalone Matter's
current mirror placement is outside this checkout layout decision.
