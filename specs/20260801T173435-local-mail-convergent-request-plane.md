# Local Mail convergent request plane

**Date**: 2026-08-01
**Status**: Draft
**Owner**: Braden
**Branch**: (unassigned; documentation authored on `worktree-local-mail-sync-docs`)
**Decision record**: [ADR-0198](../docs/adr/0198-local-mails-one-durable-local-write-is-a-convergent-request.md)

## One Sentence

Replace Local Mail's Gmail-first-or-fail triage write and its request-lifetime
UI optimism with one durable convergent request per message, held in the
person's Epicenter, settled inside `sync()`, and composed over provider facts at
read time.

## How to read this spec

```txt
Read first:
  One Sentence
  Current State
  Target Shape
  Execution Waves
  Verification

Read if changing the architecture:
  Why not the mirror
  Open Questions
```

The decision and its refusals live in ADR-0198. This spec is how the code gets
there and what comes out on the way.

## Preconditions

| Precondition                                                                  | State                                                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| The mail engine runs inside the Epicenter host process (ADR-0191)             | Accepted on branch `claude/local-mail-in-epicenter`, not merged |
| ADR-0198 is accepted                                                          | Proposed                                                        |
| `packages/data` exposes a bound Lens with `create` / `update` / `delete` / `scan` | Shipped                                                         |

Wave 1 cannot start before ADR-0191's host promotion lands. A separate
`local-mail app` process cannot hold request rows: it would need either a second
replica of the same Epicenter on one machine or a second writer against the
desktop host's replica file. Both are refused.

## Current State

### The write path is Gmail-first or nothing

`apps/local-mail/src/modify.ts`:

```ts
async function foldMessageMutations({ deps, ids, mutate }) {
	for (const id of ids) {
		const { data: message, error } = await mutate(id); // Gmail first
		if (error) { /* per-id 400/404 continues, anything else aborts */ }
		tryFoldMessageLabels({ db: deps.db, id, labelIds: message.labelIds, syncedAt });
	}
}
```

Offline, `mutate` fails for every id and the human's decision is gone.

### Optimism lives as long as the HTTP request

`apps/local-mail/ui/src/lib/optimistic.ts`:

```ts
export function readPendingWrites(queryClient: QueryClient): PendingMessageWrite[] {
	return queryClient
		.getMutationCache()
		.findAll({ mutationKey: MESSAGE_WRITE_MUTATION_KEY, status: 'pending' })
		.map((mutation) => mutation.state.variables as PendingMessageWrite);
}
```

The pending mutation *is* the intent, so a reload, a crash, or a failed call
erases the projected change.

### Everything else is already the right shape

- `db.ts` is a reader materialization named `mail.v5.db` by `MIRROR_VERSION`
  (ADR-0196, ADR-0197). No change here, and no corpus-version bump in this work.
- `applyLabelDelta`, `applyLabelDeltas`, `rowMatchesLabelFilter`, and
  `projectMessageList` in `optimistic.ts` are pure algebra and survive unchanged.
- `deltaForTrashed` already models trash as a `TRASH` label delta, which is the
  same algebra a request stores.
- `sync.ts` already owns one pass per account with a per-account lock
  (`lock.ts`) and a mode decision.

## Target Shape

### The Lens

```ts
// apps/local-mail/src/requests/lens.ts
export const mailLens = defineLens({
	namespace: 'so.epicenter.mail',
	tables: {
		requests: defineTable({
			fields: {
				account: field.string(),
				messageId: field.string(),
				/** { [labelId]: 'present' | 'absent' }. `TRASH` routes to
				 *  messages.trash / messages.untrash rather than messages.modify. */
				desired: field.json(DesiredLabels),
				requestedAt: field.string(),
			},
		}),
	},
	values: {},
});
```

One row per `(account, messageId)`. Row ids are runtime-minted:
`CreateInputFor` types `id` as `never`, so the uniqueness invariant is the single
local writer's, not the schema's.

### The settler

```ts
// apps/local-mail/src/requests/settle.ts
/** Apply every unresolved request for one account to Gmail, folding each
 *  response into the mirror and deleting the request it satisfied. */
export async function settleRequests(deps: SettleDeps): Promise<SettleOutcome>;
```

Per request row, in one pass:

```txt
read the row's desired map
   |
   +-- TRASH key present?  -> messages.trash / messages.untrash
   |
   `-- other keys present? -> messages.modify(add, remove)
             |
             v
   fold returned labelIds into the mirror (existing patchMessageLabels)
             |
             v
   recompute desired against the folded fact
     agrees   -> drop the key; map empty -> delete the row
     400/404  -> delete the row, report it
     other    -> leave the row, report it, stop the account's pass
```

### The pass

```ts
// apps/local-mail/src/sync.ts
export async function syncMailbox(deps, { forceFull }): Promise<SyncOutcome> {
	const settled = await settleRequests(deps); // first, so the refresh sees the effects
	const refreshed = await refreshProviderFacts(deps, { forceFull });
	return { ...refreshed, settled };
}
```

No second public verb, no ordering flag, no drain hook.

### The read composition

```txt
SQL over provider facts        unresolved request rows
(pushed-down filter + sort)    (bounded, in memory)
            \                        /
             \                      /
              projectMessageList(...)   <- existing pure algebra
                        |
                        v
        ProjectedMessage { ...fact, labelIds, pending: boolean }
```

`pending` is what the UI renders as "waiting for the next sync". It is required,
not optional: ADR-0198 makes "shown as applied" and "shown as not yet in Gmail"
one decision.

### File tree

```txt
apps/local-mail/src/
├── requests/
│   ├── lens.ts        so.epicenter.mail, the requests table
│   ├── record.ts      the named domain transitions
│   ├── settle.ts      the one settler
│   └── project.ts     compose unresolved requests over provider facts
├── modify.ts          KEEPS the Gmail call + fold spine; LOSES its role as the write entry point
├── sync.ts            settle, then refresh
└── db.ts              unchanged (no new column, no MIRROR_VERSION bump)
```

## Why not the mirror

```txt
mail.v5.db  --- corpus version bump --->  mail.v6.db (empty, backfilling)
    |                                          |
 requests stored here                     nothing migrates
    `-- stranded in a predecessor no read path opens (ADR-0197)
```

Plus ADR-0098 names an overlay table beside the mirror as the exact hazard it
exists to catch, and ADR-0196 closes the mirror's stored shape at three tiers.

## Execution Waves

Each wave ends with the tree green and one write path, never two.

### Wave 0: preconditions (not this work)

- [ ] ADR-0191's host promotion merges; `app.ts`, `presence.ts`, `mintBearer`,
      `window.__LOCAL_MAIL__`, and `src-tauri` are deleted with it.
- [ ] ADR-0198 flips to Accepted, and `Amended by: ADR-0198` replaces the
      provisional Relates note on ADR-0098.

### Wave 1: the request plane exists and is the only write path

- [ ] Add `requests/lens.ts`, `requests/record.ts`, `requests/settle.ts`.
- [ ] Bind the Lens where the host already holds the Epicenter, one binding per
      process, passed into the mail engine's composition root. No handle reaches
      a route or a component.
- [ ] Rewrite the HTTP write routes to call the named transitions
      (`archive`, `markRead`, `trash`, ...) instead of
      `resolveAndModifyMessageLabels` / `setMessagesTrashed` directly.
- [ ] `LOCAL_MAIL_READ_ONLY` refuses to record a request, before any Gmail call.
- [ ] **Delete**: the direct Gmail-first entry from the HTTP surface. `modify.ts`
      keeps `foldMessageMutations`, `resolveLabelIds`, and the per-id error rule,
      now called only by the settler and by the CLI/MCP surfaces.

Checkpoint: an online archive still works end to end and now leaves a request row
that is deleted within the same call.

### Wave 2: durable optimism replaces request-lifetime optimism

- [ ] `requests/project.ts` turns unresolved rows into the `PendingMessageWrite[]`
      the existing algebra already consumes.
- [ ] The read routes return `ProjectedMessage` with `pending`.
- [ ] **Delete**: `readPendingWrites`, `MESSAGE_WRITE_MUTATION_KEY`, and the
      mutation-cache subscription in the page. Keep `applyLabelDelta`,
      `applyLabelDeltas`, `rowMatchesLabelFilter`, `projectMessageList`,
      `deltaForTrashed`.
- [ ] **Delete**: `reconcileAfterWrite`'s role as the thing that keeps a delta
      alive across a refetch. The request row now owns that lifetime.

Checkpoint: archive offline, quit, reopen. The row is still archived and still
labelled as waiting.

### Wave 3: one pass, honest status

- [ ] `syncMailbox` settles then refreshes; `SyncOutcome` reports both.
- [ ] `MailStatus` gains `unsettledRequests: number` and `oldestRequestedAt`.
- [ ] The SPA status bar says how many changes are waiting and since when.
- [ ] Wire the settler to run on a named transition as well as on the interval,
      through the same account gate, so an online write still feels immediate.

### Wave 4: state the headless asymmetry

- [ ] CLI `modify` / MCP `modify_labels` keep writing Gmail-first with no request
      row. Their help text and tool descriptions say so.
- [ ] `local-mail sync` reports that it refreshes provider facts and does not
      settle host-owned requests.

### Wave 5: not in this work

Compose, send, and attachments. ADR-0198 refuses the send outbox outright; drafts
and attachments each need their own record first.

## Verification

```bash
bun run check                       # the canonical gate
bun test apps/local-mail
bun scripts/check-doc-hygiene.ts
```

Behavioral proofs, each a test:

- [ ] Archive with Gmail unreachable: a request row exists, the projected row
      leaves Inbox, `pending` is true.
- [ ] Archive then undo before any settle: no request row remains, and no Gmail
      call was made.
- [ ] Settle when Gmail already agrees (the change was made on the phone): the
      row is deleted and no `messages.modify` is sent.
- [ ] Settle against a `404` id: the row is deleted, the outcome reports it, and
      the pass continues.
- [ ] A restart with unsettled rows still projects them.
- [ ] `LOCAL_MAIL_READ_ONLY` records nothing and calls nothing.
- [ ] The mirror's declared shape and `MIRROR_VERSION` are untouched by the whole
      change (grep proof: no diff in `MIRROR_TABLES` or `MIRROR_VERSION`).

Grep proofs for the deletions:

```bash
rg 'MESSAGE_WRITE_MUTATION_KEY|readPendingWrites' apps/local-mail   # expect no hits
rg 'resolveAndModifyMessageLabels|setMessagesTrashed' apps/local-mail/src/http  # expect no hits
```

## Open Questions

Each of these is a product promise, not a technical unknown. ADR-0198 records the
recommendation; none is silently decided by implementation.

1. **Does the durable request promise unattended delivery?** Recommendation: no.
   Requests settle while the Epicenter host is open, and the UI says "waiting for
   the next sync". Promising more needs an always-on owner, the reopen trigger
   ADR-0098 and ADR-0116 already named.
2. **Are unsent draft bodies allowed to replicate through Epicenter servers?**
   Recommendation: not in v1. Compose is Gmail-backed and requires the account to
   be reachable, which is also what makes a draft visible on the phone
   (ADR-0098). Offline compose is a separate ADR because it replicates unsent
   bodies and the provider text they quote.
3. **Is multi-device concurrent draft editing a requirement?** Resolved by
   evidence: no. Local Mail ships no phone code (ADR-0080, ADR-0083) and Gmail's
   app cannot edit an Epicenter row, so if an authored body ever becomes durable
   it is a scalar field, not a Yjs document.
4. **Attachments.** Refused in v1. ADR-0173's row-bound blob plane is Proposed and
   unimplemented and ADR-0196 refuses bytes beside the mirror, so there is no
   governed place to put them.
5. **Does Mail get its own Epicenter replica?** Recommendation: no, and it cannot.
   The request plane requires ADR-0191's in-process host. This spec states that as
   a precondition rather than deciding the topology inside it.
6. **Is metadata replication acceptable?** Message ids, label ids, and timing
   reach the Epicenter authority; subjects, senders, and bodies never do. If that
   is not acceptable, the honest answer is the fallback in ADR-0198's alternatives
   (no durable request plane, no offline triage), not a hidden local store.
