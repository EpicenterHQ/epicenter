# 0360. Defer automated hosted account deletion

- **Status:** Proposed
- **Date:** 2026-09-08
- **Delivery:** Automated account deletion is deferred for the zero-user V1.
- **Unbuilt:** Complete allocation ownership, a tested operator deletion procedure, and automated erasure with write retirement and durable retries.

## Context

The former endpoint removed blobs, billing, observations, and the auth user,
then reported success while omitting store authorities and generation ledgers.
It could also leave verification records and data recreated by ongoing writes.
The endpoint now refuses before destructive work and the UI disables deletion.

The user confirmed that there are no real users and historical hosted test data
is disposable. A read-only Cloudflare inspection on 2026-09-08 found both API
Durable Object namespaces empty. The [storage map](../../apps/api/worker/account/README.md)
records the evidence and its limits. No reset is currently justified.

## Decision

Defer automated account deletion for the zero-user V1. Do not build a coordinator,
scheduler, public progress UI, receipt system, or generic deletion framework now.
Keep `DELETE /api/account` returning `503 ACCOUNT_DELETION_UNAVAILABLE` after its
fresh-session and principal-binding checks. It accepts no deletion job.

Keep storage ownership explicit as allocation paths evolve. Before onboarding
external users, establish complete account attribution and locally test an
operator-run procedure for retiring access and removing all owned hosted data.
Neither capability is already established by the refusal tests. Automation can
wait; recoverable ownership should not be left to a later cleanup project.

Revisit automation when self-service account deletion becomes a product
requirement or operator-run deletion becomes recurring work. A calendar year is
not the trigger. Start with the smallest mechanism supported by the workload;
Postgres job records are a candidate because hosted accounts already use it.
No coordinator technology or public status protocol is selected by this record.

Future automated deletion must survive auth revocation, retry partial failures,
and prevent ongoing writes from recreating erased data. It includes owned
Postgres records, store authorities and ledgers, blobs, and billing cleanup.
Device copies remain outside hosted erasure. Any retained deletion metadata and
external-provider retention must be stated in the completion contract.

Account lifecycle stays hosted-only. Self-host entry points receive no deletion
flags, bindings, or no-op services. Their shared `instance` bearer grants no
whole-instance reset operation; operators control their own infrastructure.

## Consequences

V1 has no self-service account deletion. The remaining work is tracked in
[the backlog](../../BACKLOG.md), not an active implementation spec. The prior
workflow exploration remains recoverable from Git history.

The empty namespace observation must be rechecked after old allocations stop
before relying on it for a future cutover. This decision authorizes no deployment,
namespace purge, or other production change.

## Considered alternatives

- Build the complete workflow now: spends effort on automation before there are
  users or an established manual procedure.
- Defer ownership along with automation: risks creating storage that cannot later
  be attributed to the account that requested deletion.
- Restore the old synchronous endpoint: would again claim erasure without proving
  discovery, write retirement, or completion.
- Build an instance reset alongside hosted deletion: invents a separate product
  action and adds machinery that self-hosted clients do not need.
