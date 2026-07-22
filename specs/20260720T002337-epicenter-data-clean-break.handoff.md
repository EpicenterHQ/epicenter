# Execute Epicenter data W1A: shared semantics and maintained harness

You are continuing the Epicenter data clean break. Work as the primary
orchestrator, and use the literal `/codex:rescue` command where bounded
excavation, focused edits, or an independent verification pass buys speed or
confidence.

## Mission

Execute only W1A of
`specs/20260720T002337-epicenter-data-clean-break.md`: rewrite the private V1
protocol kernel from kinded row/value shapes to the universal record model,
land the four-operation composition proofs, and promote the disposable lane
probe into the maintained repository conformance suite.

Stop before implementing the production replica store or any production
adapter. W1A may use one unexported test-only SQLite reference driver as its
oracle. The point of this checkpoint is to freeze one shared semantic kernel
and one proof surface before work fans out.

## Start from the frozen branch

The documentation branch is `codex/epicenter-data-wave-0-freeze`. It contains
three Wave 0 commits plus a fixup that moves documents and blobs before caller
migration, makes snapshot capture a first-release Home capability, and moves
the maintained harness into W1A.

Do not implement in the original dirty worktree. Create a fresh implementation
worktree and branch from the corrected Wave 0 branch, for example:

```sh
git worktree add /Users/braden/Code/epicenter-worktrees/epicenter-data-wave-1 \
  -b codex/epicenter-data-wave-1-replica \
  codex/epicenter-data-wave-0-freeze
```

Use that new worktree as the execution root for every subsequent read, edit,
test, and commit. The absolute scratch-evidence paths below are the only reads
that intentionally reach back into the original worktree.

Before editing, verify that the worktree is clean and that this handoff and the
corrected W1A section are present. If the branch has moved or the live code
contradicts this state, stop and reconcile the branch instead of recreating the
Wave 0 decisions from the transcript.

## Read first, in order

1. `AGENTS.md` and any nested instructions for files you touch.
2. `specs/20260720T002337-epicenter-data-clean-break.md`, especially Accepted
   premises, Protocol kernel status, W1A, and Recognition criteria.
3. `docs/adr/0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md`
   for the kindless record address.
4. `docs/adr/0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md`
   for one fact shape, four operations, absorption-first composition,
   canonical retry bytes, and admission grammar.
5. `docs/adr/0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md`
   for per-record convergence.
6. `docs/adr/0177-each-store-owner-persists-records-in-one-wide-interned-crash-state-relation.md`
   for the lane machine and the role of the maintained harness. W1A freezes
   semantics and tests; it does not commit production code to the wide layout.
7. The complete private kernel under `packages/data/src/protocol/v1/`.
8. `/Users/braden/Code/epicenter/tmp/eval-20260721-lane-probe/probe.ts` and
   `/Users/braden/Code/epicenter/tmp/eval-20260721-lane-probe/report.md` as
   disposable evidence to promote, not source files to import or preserve.

The transcript at
`/Users/braden/Code/epicenter/2026-07-21-215646-epicenter-data-wave-0-freeze-the-greenfield-ar.txt`
is historical context only. ADRs, the corrected spec, and live code win.

## Current state to verify

- `packages/data/src/protocol/v1/` is private and has no production consumer.
  Confirm that with `rg` before relying on it; then rewrite rather than add
  compatibility aliases.
- The kernel already owns useful machinery: defensive RFC 8785 canonical
  encoding, deep-frozen admitted requests, pure fold/reference-authority code,
  and runtime-free tests. Preserve those properties while deleting kinded
  row/value addresses and their eight operation/fact variants.
- The scratch probe executed eleven transitions spanning replica, authority,
  and document cleanup responsibilities against in-memory ADR-0177-shaped
  fixtures. It rolled back transaction prefixes and compared serialized
  logical table contents. It did not kill a process, reopen a persisted file,
  or persist the sealed request bytes and hash that ADR-0163 now requires.
- W0 intentionally landed no maintained harness. W1A owns that missing gate.

## Required work, in dependency order

### 1. Freeze the shared semantic types

Replace durable and wire-level row/value kinds with one record address:
`namespace`, `collection`, and `recordKey`. Expose one fact shape and exactly
four operations: `patch`, `replace`, `tombstone`, and `unset`.

Delete the obsolete private types and tests cleanly. Do not keep aliases,
dual schemas, fallback admission, a sentinel record, or a compatibility
decoder. Keep table-versus-values interpretation out of the protocol kernel.

### 2. Prove the operation algebra

Translate the existing fold and operation tests to records. Add a reference
proof that composed operations equal sequential application across randomized
operation sequences. Tombstone absorption is checked first, before payload or
operation-specific logic. Cover unknown fields, null, missing fields, unset,
replacement, and every tombstone pairing that can expose an ordering mistake.

The pure reference authority may stay because W2 will use it, but do not build
the authority store, HTTP wire, constants, or Cloudflare adapter in this
checkpoint.

### 3. Promote the lane probe

Turn the probe's eleven transitions into maintained reference cases, partitioned
by the owner they exercise: replica, authority, or document/blob lifecycle.
Preserve what the probe actually proved: inject failure after every statement
boundary and require rollback to restore equivalent logical state. Then
strengthen the maintained harness with a file-backed close and reopen after
each injected failure. Add the first-seal assertion the probe lacked: persist
the canonical request bytes and hash selected by the initial seal, then prove
they remain the exact retry bytes even when newer pending work arrives.

W1A runs all eleven against explicit reference fixtures so none remain trapped
in `tmp/`. It defines the reusable conformance contract for the replica subset
only. W1B and W1C bind that subset to production replica adapters; W2 binds the
authority subset; W3 binds the document/blob lifecycle subset. Do not implement
those later production owners in this checkpoint.

The harness may contain one unexported test-only SQLite reference driver. Keep
it visibly an oracle, not a fake product store or public adapter. Use the
disposable probe to recover the cases and failure boundaries, then write
repository-owned tests in the package's normal style. Do not import from
`tmp/`, copy its report into docs, or keep a scratch runner as a production
dependency.

Blob staging fault cases belong to this same maintained suite, but W3 owns the
real blob foundation. Do not add skipped tests or a stub blob adapter merely to
claim them in W1A.

### 4. Stop and review

Run a post-implementation review over every touched file. Confirm there is one
record vocabulary, one operation algebra, one reusable conformance case set,
and no production replica store. Update the spec only if implementation
evidence changes a claim; do not mark W1 or the whole spec complete.

## Candidate `/codex:rescue` seams

Use or revise these after reading the live tree. They are options, not a job
queue.

- Kernel excavation: map every kinded V1 type, constructor, schema, and test;
  return a delete/translate/keep inventory and any production imports.
- Probe extraction: compare the scratch probe with ADR-0163 and ADR-0177;
  return the exact eleven transitions, fault boundaries, and reusable driver
  requirements without editing.
- Independent proof review: attack the randomized composition oracle and
  tombstone cases for circularity or missing operation pairs.
- Verification: run the focused commands below and return pass/fail output,
  changed files, and any pre-existing failure reproduced on the Wave 0 base.

## Proof and stop condition

At minimum, run:

```sh
bun test packages/data/src/protocol/v1
bun run --filter '@epicenter/data' typecheck
bun run check:doc-paths
bun run check:doc-hygiene
```

Also run the maintained conformance suite by its final repository path and the
smallest relevant package lint or format checks. Use bun only.

Stop with one or more standalone commits when:

- the private kernel admits and emits only record addresses, one fact shape,
  and the four operations;
- composition versus sequential application and absorption-first tombstone
  behavior pass;
- all eleven reference transitions restore equivalent logical state after
  every statement-boundary failure, and the strengthened file-backed suite
  closes and reopens cleanly, with cases partitioned by their future
  production owner;
- first-seal request bytes and hash remain exact across retry and newer pending
  work;
- focused tests and typecheck pass, with any unrelated repository failures
  separated explicitly;
- the post-implementation review finds no compatibility residue or premature
  adapter work.

Do not implement the production replica, browser OPFS, authority store or HTTP
wire, Lens API, documents, blobs, snapshot capture, Backup/Restore, Proposal,
or Workspace migration. Do not push or open a pull request without separate
authorization.
