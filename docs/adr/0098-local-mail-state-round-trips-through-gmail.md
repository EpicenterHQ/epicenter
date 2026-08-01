# 0098. Every Local Mail concept a human acts on round-trips through Gmail API state

- **Status:** Accepted
- **Date:** 2026-07-01
- **Amended by:** [ADR-0197](0197-a-mirrors-corpus-version-names-its-artifact-and-only-the-app-knows-when-one-is-ready.md) at the mechanical-enforcement clause only: the `SCHEMA_VERSION` drop-and-rebuild that punished local-only state in mirror tables is withdrawn. The round-trip rule itself is untouched. Also amended by [ADR-0198](0198-local-mail-stores-gmail-facts-and-durable-local-overlays-in-one-stable-file-per-account.md) at the local-only-state refusal, which gains one bounded exception: a mutation that IS expressible in the Gmail API may be staged durably on disk as a local overlay before it round-trips, with the pending state visible in the UI. The rule that every human-actionable concept must be Gmail-expressible is untouched, and snooze and send-later stay refused (ADR-0199 refuses queued send for that reason).
- **Relates:** [ADR-0080](0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md) (cross-device is a remote session, not per-app phone code, so the phone reads mail in the phone's own mail app), [ADR-0081](0081-per-upstream-oauth-concurrency-decides-mirror-topology.md) (each device holds its own mirror against Google directly), [ADR-0082](0082-local-mail-syncs-by-push-free-history-list-polling.md) (writes hit Gmail first; the mirror folds the result in after), [ADR-0083](0083-apps-email-is-refused-local-mail-is-the-only-gmail-client.md) (Local Mail is the only Gmail client)

## Context

Local Mail ships no phone code: the phone client is Gmail's own app (ADR-0080 keeps cross-device as a remote session rather than per-app reach, and ADR-0083 refused the webmail SPA that could have filled that slot). That only stays consistent if every state change a human makes on the desktop lands in Gmail, where the phone app can see it. The mechanics are already decided: per-device mirrors against Google directly (ADR-0081) and write-through, Gmail first, mirror folded in after (ADR-0082). What had no durable home was the product refusal those mechanics serve. Until now it lived as one row of a deletable Draft spec's decision table, which is a homeless place for a load-bearing invariant: specs are deleted when the work lands.

## Decision

**Every Local Mail concept a human acts on must be expressible as, and round-trip through, Gmail API state. Local Mail refuses local-only mail state until a future ADR accepts device-bound behavior with explicit failure semantics.**

Feature by feature:

- **Tags** are allowed only as real Gmail labels (`labels.create` plus `messages.modify`), never a local column. A tag applied on the laptop must be visible and removable on the phone.
- **Drafts** are expressible (`drafts.create`, `drafts.update`, `drafts.send`) and allowed within write-through scope.
- **Read/unread** is the `UNREAD` label and must round-trip. This is why the UI ships only with write-through: an inbox whose read state never reaches Gmail leaves every handled message unread on the phone.
- **Snooze** is refused. The Gmail API has no snooze surface. Emulating it with label moves plus a local timer makes the state expressible but the behavior device-bound: a laptop asleep at wake time means mail never resurfaces, and the phone can neither see nor cancel the pending snooze.
- **Send-later** is refused hardest. It is not in the API, and a silently unsent email is a commitment breach, not a UX gap.
- **Derived or advisory local data** (agent notes, triage suggestions, search annotations) is allowed when it is rebuildable and never gates handled-semantics.

The rule of thumb: any state a human acts on must round-trip through Gmail.

## Consequences

- The phone story holds with zero Local Mail phone code: whatever the desktop does, Gmail's own app reflects it.
- Enforcement is partly mechanical. The mirror's only writer is `sync.ts` (later, the write-through cores). This record originally claimed a second mechanical guard: the schema's drop-and-rebuild on a `SCHEMA_VERSION` bump destroyed any state stored in mirror tables, so a violation that smuggled precious local state into the mirror was punished at the next bump. **ADR-0194 withdrew that guard, and ADR-0197 keeps it withdrawn.** A version bump now names a new artifact and retains the predecessor; opening destroys nothing, so nothing is punished later. What replaces it is earlier and more visible: local-only state has to appear in the reviewed table declarations to exist at all, which is where the violation is now caught. Overlay tables beside the mirror remain the escape hatch this ADR exists to catch in review.
- Snooze and send-later stay off the roadmap regardless of demand until the revisit trigger fires.
- Revisit trigger: an always-on device that can own timers (the super-app desktop host of ADR-0080, or a home server) would make snooze semantics honest, because the timer survives a laptop lid and cancellation has one home. That is the earliest credible reopen, and it takes a new ADR accepting device-bound behavior with explicit failure semantics.

## Considered alternatives

- **Emulate snooze with label moves plus a local timer.** Rejected: the state round-trips but the behavior does not; a sleeping laptop silently breaks the "it comes back" promise, and the phone cannot see or cancel it.
- **A local tags column beside `label_ids`.** Rejected: it forks the labeling model into one the phone can never see. The original second reason (the mirror's drop-and-rebuild would destroy it anyway) is gone under ADR-0197, which retains the predecessor instead of destroying it. The first reason was always the load-bearing one.
- **Ship read/unread UI before write-through.** Rejected: reading mail flips human-meaningful state; if that flip cannot reach Gmail, the phone shows as unread what the user already handled.
