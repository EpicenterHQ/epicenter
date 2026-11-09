# Billing and the Autumn boundary

A map of how cloud billing works in `apps/api/worker/billing/`, written so the
next person (or the next you) does not have to reverse-engineer it from the
source files. If you are about to change anything in this folder, read this
first.

## The one sentence

> Meter and gate paid AI usage against Autumn. Autumn can be slow, wrong, or down
> at any moment, so it must deny work when entitlement cannot be verified, never
> permanently charge for work that did not happen, and never leak provider
> internals to the user.
>
> (Storage is unmetered in v1: the opaque-ID blob store makes no Autumn
> call. The billed era is sketched at the end of this guide.)

Every design choice below is a consequence of that second clause. If a piece of
code does not serve "treat the provider as fallible and untrusted," it is
probably ceremony. If it does, it earns its keep even when it looks like a smell.

## The layers

```
dashboard (apps/api/ui)            ui/src/lib/billing/api.ts   typed fetch client, Result<T, …>
        │  HTTP /api/billing/*
        ▼
routes.ts        HTTP shape: validate body, delegate, translate thrown errors
        │
        ▼
service.ts       one facade per request: every billing operation, returns DTOs
        │
        ▼
autumn.ts        the ONLY file that imports autumn-js. builds the client with
        │        failOpen: false, classifies provider failures, logs details
        ▼
Autumn (external, fallible)
```

`policies.ts` sits to the side: it wraps the AI inference route (which lives in
`@epicenter/server`) with the same `service.ts`, to reserve credits around work
the library does not know is billable.

Be precise about the boundary. `autumn.ts` is not a full provider-swapping
adapter. `service.ts` still speaks Autumn-shaped concepts: `check`, balances,
subscriptions, and plan eligibility. That is intentional. The useful
boundary is narrower: one SDK import site, one fail-closed client default, and
one place that turns provider failures into our billing error.

## Three error buckets, two error paths

Keep these separate:

```
provider error     AutumnError or HTTPClientError. Provider failed or rejected
                   our provider-level request. Opaque BillingError, fixed 503.

domain error       Credits, plan, or model state denies the user.
                   Typed surface error with an actionable status and payload.

programmer error   Our code is wrong. TypeError, bad mapping, impossible branch.
                   Rethrow to the parent app so it becomes a real 500.
```

There are two ways a provider failure reaches the client, and they look
inconsistent until you see why.

```
DASHBOARD READS                        USAGE GUARDS
getOverview, listPlans, listUsage…     reserveAiChat
        │                                      │
 Autumn provider error throws           tryAutumn catches provider error
        │                                      │
 routes.ts onError                      service returns Result
        │                                      │
 provider error -> 503                  policy forwards error to c.json
 local bug -> real 500                  local bug keeps throwing
        │                                      │
        ▼                                      ▼
   503 envelope                           4xx/503 envelope
```

Why the asymmetry: a guard is the last stop before expensive or billable work,
so it returns `Result` and lets the policy shape the HTTP response. A read has
no work to protect and no post-response operation to schedule, so it lets
provider errors throw to the single `onError` boundary in `routes.ts`. The split
is real work, not inconsistency. Both paths should still agree on the important
rule: provider failures become the opaque billing 503, and local programmer
bugs stay bugs.

## AI reservations: reserve, then confirm or release

For AI calls, we do not deduct up front and refund on failure. We take a
**lock** (a held balance), do the work, then commit or roll back.

```
reserveAiChat ─► autumn.check({ requiredBalance: N,
                                lock: { lockId, expiresAt: now + 15min } })
                 │  N credits are HELD, not spent
                 ▼
             do the work (stream the model)
                 │
        ┌────────┴─────────┐
   status < 400        status >= 400
        │                  │
   confirm()           release()
   finalize(confirm)   finalize(release)
   commit the charge   give the held credits back
```

`confirm` and `release` are the same one line (`finalizeLock(lockId, action)`)
with the action flipped. `confirm` commits the held balance, `release` returns
it.

### Why a lock and not Autumn's lighter `check({ sendEvent })`

Autumn's docs frame `lock`/`finalize` as the heavyweight primitive for
distributed holds, and steer you to `check({ sendEvent: true })` or
`check` + `track` for ordinary metering. We use the lock anyway for one reason:
the `expiresAt` TTL. On Cloudflare Workers an isolate can be evicted
mid-request. If we charged up front and the worker died before refunding, the
user would be over-charged forever. With a lock, a worker that dies between
reserve and settle simply lets the hold expire at the TTL: no charge, no manual
recovery. That crash-safety is what the lock buys. (We never pass
`override_value`, so we are not using the lock's variable-amount feature; the
TTL auto-release is the whole justification.)

The lock is biased against permanent overcharge, not against every possible
undercharge. If the downstream work succeeds but the after-response
`confirm()` cannot reach Autumn, the hold eventually expires and the user may
not be charged for that completed work. That is intentional: the pre-work guard
still fails closed when entitlement cannot be verified, and the post-work
settlement prefers a bounded undercharge over permanently charging a user for
work that failed or could not be settled. For AI streams, once the stream has
started the HTTP status is already 200, so a later model/provider failure still
confirms by design: provider tokens were consumed and cannot be refunded.

## Storage accounting: unmetered in v1

Storage is **not metered today**, and Epicenter hosts no blob store
(ADR-0577). The old assets surface (a Postgres `asset` table + an
`ASSETS_BUCKET` R2 binding) was retired into an opaque-ID blob store, which
was itself deleted; neither made an Autumn call, so there is no upload guard
and no usage sync. The asset-table-coupled
wiring (`syncAssetStorageWithAutumn` policy, `checkAssetStorageUpload` /
`syncAssetStorageUsageTotal` service methods) is gone.

What survives is the **plan shape**, kept for the billed era: `getOverview()`
still reports `storage: { usedBytes, includedBytes }` (the dashboard's allowance
card), the catalog still carries `storage.includedBytes` per plan, and
`FEATURE_IDS.storageBytes` still names the Autumn feature. In v1 nothing writes
usage, so `usedBytes` reads as the unwritten balance (effectively 0).

When storage is billed (deleted blob spec `20260623T220000` decision 10,
recoverable via git history; kernel is ADR-0089 as amended by ADR-0148), the meter
will be a **stock sync, not event deltas**: the opaque-ID object store is its
own index, so an occasional `ListObjectsV2` SUM over `principals/<principalId>/blobs/`
drives one absolute `autumn.balances.update({ usage })`. That is self-correcting
(a missed update is overwritten by the next sweep) and needs no second ledger,
which is exactly why the retired asset path also synced an absolute total rather
than upload/delete deltas. A `syncBlobStorageWithAutumn` policy will carry it
(`apps/api/worker/index.ts`, beside `chargeOpenAiCreditsWithAutumn`);
`mountBlobsApp` takes no `policies` today, so that change adds the seam and the
policy together.

## Errors: opaque on the wire, fat in the logs

A `BillingError` means exactly one thing: the call to Autumn failed, so we fail
closed. It is deliberately a single opaque message:

> "Billing is temporarily unavailable. Please try again."

It carries no HTTP status, no Autumn `code`, no provider wording. Whether Autumn
returned a 502, a 503, or a socket timeout, the only honest answer to the user
is the same, and surfacing the vendor's text would leak internals. The full
original error (status, body, class) is logged for operators at `mapAutumnError`
in `autumn.ts`. Thin wire, fat log.

The **actionable** states are NOT `BillingError`. "Out of credits" is
`AiChatError.InsufficientCredits({ balance })`, surfaced with the real number so
the dashboard can offer a top-up. "Model needs a paid plan" is
`AiChatError.ModelRequiresPaidPlan`. Those are typed domain variants with their
own statuses. So we surface specifics when the user can act, and silence when
they cannot (our provider broke). That is the right amount, not too much.

A programmer error is neither of those. If a handler throws a `TypeError`, a
mapper reads the wrong shape, or a local invariant is wrong, that should remain
a real 500. Do not turn our bug into "billing is temporarily unavailable"; that
sends the operator and the user looking in the wrong direction.

## Three things that look like smells and are not

If you come in with fresh eyes (good instinct), these will draw suspicion. Here
is why each survives:

1. **`error instanceof AutumnError || error instanceof HTTPClientError`**
   (`autumn.ts`, `isProviderError`). This is not branching on the difference
   between the two; it is membership in *either*. Autumn throws two unrelated
   class families: `AutumnError` (the service answered with a status) and
   `HTTPClientError` (the network never reached it: connection refused, timeout).
   Checking only `AutumnError` would let a real outage become a misleading 500
   instead of a fail-closed 503. The `||` is what makes "fail closed" closed.
   If duplicate `autumn-js` copies ever appear in the dependency graph, revisit
   this classifier: `instanceof` depends on both sides using the same class
   object.

2. **`confirm` vs `release`.** Not two code paths, one line with the action
   flipped. Minimal, not ceremony. (See the reservation diagram above.)

3. **The opaque message.** Intentional, not lazy. The informative errors have
   their own types; the opaque one is reserved for "the provider itself broke,"
   which is precisely the case that should leak nothing.

## The one genuine bit of ceremony

In `mapAutumnError`, the `instanceof AutumnError && statusCode < 500` branch
chooses `log.error` vs `log.warn`. Both arms return the identical
`BillingError`. The only difference is log severity (a 4xx from Autumn means we
sent a bad request and warrants attention; a 5xx or network failure is a
transient outage). It is defensible operational signal, but it is the only place
the two error tiers are treated differently, and the only branch you could
delete with zero behavior change.

## The real caveat

Post-response billing work (the AI `confirm()`/`release()` settlement, and any
future storage sync) is fire-and-forget on the after-response queue. If it
cannot reach Autumn, the provider's projection can drift from reality. The AI
lock self-heals at its TTL. The deferred storage meter is designed to be
self-correcting the same way: an absolute LIST-SUM sync, where the next sweep
overwrites any drift, rather than replayed upload/delete deltas that compound a
missed event.

## If you are changing this folder

- Adding a new billable operation: it goes through `service.ts`, which calls
  Autumn only via `autumn.ts`. Do not import `autumn-js` anywhere else.
- A new fallible-work guard: follow `reserveAiChat`: reserve a lock, return a
  reservation the policy settles around `next()`.
- Metering blob storage: drive one absolute `autumn.balances.update({ usage })`
  from a blob-store LIST-SUM (the store is its own index); do not reintroduce a
  Postgres table or upload/delete deltas.
- A new dashboard read: let Autumn throw; `routes.ts` `onError` turns a provider
  failure into the opaque 503 and rethrows real bugs to a 500.
- A new post-response billing operation without a lock needs an explicit
  recovery story. Locks self-heal at TTL; direct sync calls do not.
- Never widen the `BillingError` message to include provider text. That is the
  one invariant the whole error design protects.
