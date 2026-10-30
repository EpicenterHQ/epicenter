# Native Git synchronization evidence

Recorded on 2026-10-19 with Bun 1.4.3 on macOS arm64, starting from
`e3b44dcf68`. [Browser results](results.json) retain engine versions, exact
commit identities, final fields and checks. All servers and repositories were
temporary and bound to loopback. No production operation ran.

## Browser workload

`smoke/sync.ts` bundles the production local engine and Git transport. Each
engine uses two pages of a temporary persistent profile and a native
`git http-backend` server behind a same-origin proxy. The server permits
conditional fast-forward updates and rejects rewrites and branch deletion.

Each tab makes 25 successive saves to its own frontmatter field while both
run synchronization attempts. The tabs then edit independent body paragraphs.
Native `git show` reads both final fields and paragraphs from the server.

The browser next pushes `a: 777`. Its request wrapper drains the actual
receive-pack response, then throws to simulate a lost reply. The runner checks
that native main equals the browser's exact pending oid. Native Git then
commits `a: 888`; the browser saves the independent `extra: 999` field. The
whole browser closes gracefully and reopens the same profile, retaining the
uncertain commit and newer E. Recovery must keep 888 and 999 without replaying
777. Native history contains the accepted pending commit exactly once.

| Engine | Acknowledged saves | Final fields | Accepted commit occurrences |
| --- | ---: | --- | ---: |
| Chromium 153.0.8010.12 | 54 | a=888, b=25, extra=999 | 1 |
| WebKit 26.5 | 54 | a=888, b=25, extra=999 | 1 |
| Firefox 151.0 | 54 | a=888, b=25, extra=999 | 1 |

All three pass native `git fsck --strict`. The workload acknowledges 162
saves in total. Bounded repeated attempts let racing work progress after
editing settles; there is no starvation or network-latency bound.

## Native wire and state regressions

The cumulative focused suite passes 133 tests with 502 assertions. The new
native-server tests use the production engine over in-memory IndexedDB; the
browser workload above establishes actual browser storage and network use.
The tests exercise:

- Unknown remote, offline save, successful empty observation and native root push.
- Initial depth-1 fetch retaining only the current raw snapshot, followed by
  ordinary requests containing `have B` and `shallow B` without another depth limit.
- Independent fields and a newer local reversal after pending C was rejected.
- Lost reply after acceptance, a later native competing edit, and an acceptance
  path reachable through a native merge commit's second parent.
- A request dropped before sending, followed by retry of the identical C while
  newer E remains saved.
- A save introducing a new path between adoption capture and publication. CAS
  rejects the adoption and leaves that save for the next attempt.
- A suspended old push after another tab pushed twice, and a held fetch resumed
  after another tab adopted a newer base. Neither rewinds refs.
- Unseen deletion against an edit in both directions.
- A newer deletion removing rejected C's own contribution, for both a modified
  and a newly created file; undoing an added child without resurrecting its
  folder over an incoming file replacement.
- A stage-one field conflict later restored to the remote value, without an
  obsolete field override trailer.
- An actual incoming native pack with deltas, not just a repository packed at
  rest. The test extracts side-band pack bytes from the HTTP response and
  uses native `index-pack` and `verify-pack` to establish delta entries. The
  engine inflates and hash-verifies its objects, then pushes from its retained
  shallow state; native readback and `fsck` pass.
- An intentionally depth-limited later response that hides connecting ancestry.
  A separate full-history recovery fetch succeeds. If recovery is also cut at
  a shallow boundary, the attempt returns `UnknownAncestry` and preserves the
  exact previous state and E.

Scripted transport tests additionally cover missing fetched objects, HTTP
failure versus empty main, aborts, response-stream failures, exact advertised
base checks before sending a push, declined updates, incomplete reports and
limited local ancestry. Scripted packets are separate evidence from native Git.

## Design and review findings

Outcome-first independent GPT-6.1 Sol and Claude Opus 5.5 designs retained B/C/E,
revision publication and explicit ancestry evidence. Their initial designs
were recorded before the coordinator's algorithm was supplied. The informed
challenge exposed witnessed deletion of text from a rejected C. Codex's
correction uses a transient D: C with E's null tombstones already applied.
Rejected adoption merges B/remote/D, then D/intermediate/local. This preserves
newer text reversals while eliminating already-deleted rejected contributions.
The actual native regressions above distinguish both cases.

Adoption creates the new one-parent commit in the same transaction as refs,
objects and captured-E removal. Translating every merged raw snapshot back
into text-only E cannot preserve all native names and modes. No new durable
state or per-edit base was introduced.

Claude Sonnet 5.5 delivered the transfer adapter in a disposable clone. Its
sandbox could typecheck but could not run Bun tests. Codex inspected its files,
ran the returned tests, integrated browser Buffer initialization and a callable
HTTP request type, and reproduced native and browser checks. A Codex subagent
implemented the native fixture and browser harness; Codex inspected and ran
both. The final informed Codex review found no remaining data-loss,
false-acceptance or stale-ref blocker in this bounded slice. Review agreement
is not a substitute for the recorded checks.

The transport uses the installed isomorphic-git 1.38.5 public
[fetch](https://isomorphic-git.org/docs/en/fetch) and
[push](https://isomorphic-git.org/docs/en/push) operations. Its same-advertisement
pre-push base check was verified against the installed `_push` implementation.
Git's [smart HTTP](https://git-scm.com/docs/http-protocol) and
[shallow repository](https://git-scm.com/docs/shallow) documentation supplied
protocol grounding; native experiments establish the covered behavior.
A custom packet/pack implementation was deferred because it would add another
parser, inflater, checksum and delta implementation before bundle or memory
measurements justify that work.

## Remaining gates

This is an internal manual sync trigger. Public opening, account-bound requests,
subscriptions, user-facing status, automatic scheduling and respecting a
server's `Retry-After` deadline remain integration work. The caller can supply
an AbortSignal; the engine adds no independent network deadline.

Transfers use private in-memory workspaces. Durable publication keeps only
complete retained snapshot closures. Since this sync checkpoint, collection
reclaims older unreachable objects after snapshot publication or push
acknowledgement; see the [retention evidence](../retention/RESULTS.md).
Current-data and full synchronization captures have different costs: sync reads
both raw snapshot closures and publication writes their retained objects under
strict durability. Recovery can temporarily download full history. Measure
browser bundle size, memory, large E, and closure read/write costs on phones
before optimizing further.

The native suite covers the listed failures; it does not exhaust every raw
namespace or native mode combination. The pure tree suite covers raw entries,
folder deletion, file-directory replacement and concurrent Markdown replacements
of a directory. Multi-stage body-region override coordinates need projection
validation before recovery tooling relies on their positions.

Profile reopening is graceful. Forced process termination, power loss, quota
and eviction, cold offline application boot and real iPhone behavior remain
release gates. No Cloudflare Artifacts or hosted auth request ran. The hosted
service must independently demonstrate conditional fast-forward updates,
initial shallow exchange, later negotiation and connecting-history recovery.
Existing applications remain on the previous backend; no data migration ran.
