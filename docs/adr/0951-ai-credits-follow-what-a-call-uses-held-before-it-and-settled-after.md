# 0951. AI credits follow what a call uses: held before it and settled after

- **Status:** Proposed
- **Date:** 2026-11-17
- **Relates:** [ADR-0950](0950-api-epicenter-so-is-a-model-api-and-every-client-reaches-it-with-an-api-key.md) (every client reaches the model API with a key; ships with this record), [ADR-0634](0634-hosted-inference-is-independent-of-repository-sync.md) (Epicenter offers hosted inference with an included allowance), [ADR-0100](0100-ai-credits-are-product-units-and-the-charge-shape-follows-when-cost-is-known.md) (Superseded; credits as product units, and a charge shaped by when its cost is known).
- **Unbuilt:** all of it, beside ADR-0950. The first thing to exist is each model's token rates in `packages/ai/src/providers.ts` and a reservation that settles with an amount in `apps/api/worker/billing/service.ts`.

## Context

The hosted API bills through Autumn. Users see and buy `ai_credits`, a
wallet that wraps the `ai_usage` feature one to one; one credit is one
cent (`apps/api/worker/billing/catalog.ts`).

Chat is charged a fixed number of credits per model per call: `gpt-5.5`
is 10, priced for an average call of 750 input and 1,500 output tokens
(`packages/ai/src/providers.ts`). `chargeOpenAiCreditsWithAutumn`
(`apps/api/worker/billing/policies.ts`) holds that amount with an Autumn
lock before the call and confirms it after. A call of 200,000 tokens costs
the same 10 credits. The free plan refuses any model above 2 credits a
call (`FREE_TIER_MAX_CREDITS_PER_CALL`, `ModelRequiresPaidPlan`).

Transcription checks that the wallet is not empty, then tracks the audio's
seconds after the call. Nothing bounds a call's length, so one long
recording, or several at once, can overspend a nearly empty wallet; ADR-0100
deferred an input ceiling.

With API keys (ADR-0950), any OpenAI tool can call the gateway, so a call
priced flat is easy to send at many times its price.

Autumn, through `autumn-js` 1.2.34, holds a balance with `check` and a
lock, and settles the lock with `balances.finalize`, whose `confirm` takes
an `overrideValue`: Autumn's documentation reserves 1,000, confirms 743, and
returns 257. Autumn also has `trackTokens`, which prices a call from
models.dev's rates with a markup, after the call and without a lock.

## Decision

**A call is charged for the tokens or minutes it uses. Before the call the
gateway holds the most it can cost; after it, the gateway settles the hold
at what it cost, and the rest returns to the balance.**

- **Each model has a rate.** A chat model has credits per million input
  tokens and per million output tokens; a transcription model has credits
  per minute. The rates live in the hosted catalog
  (`packages/ai/src/providers.ts`), replacing the fixed `credits`, and
  `GET /v1/models` shows them (ADR-0950). One credit stays one cent, and
  one wallet, `ai_credits`, holds chat and transcription alike.
- **Before a chat call,** the gateway estimates the input's tokens from the
  request, sets `max_completion_tokens` to the model's ceiling when the
  request asks for more or names none, and holds the cost of both with an
  Autumn lock. A call can never cost more than its hold. The lock expires a
  little after the longest call can run.
- **During the call,** the gateway asks the provider for usage
  (`stream_options.include_usage`) and passes every byte through unchanged,
  reading the final usage chunk on the way.
- **After the call,** the gateway confirms the lock at the real cost,
  rounded up to a whole credit, off the response's path (`waitUntil`). A
  call refused before it streams releases the lock. A stream that ends
  without usage, because the client disconnected or the provider sent
  none, confirms the input's estimate and the output counted from the
  characters sent. Letting the lock expire is the last resort only when the
  Worker dies, so ending a call early is never free.
- **Transcription works the same way.** The gateway refuses audio over a
  maximum size, holds the cost of the longest audio that size can carry,
  and confirms at the audio's seconds times the model's rate.
- **The balance travels with the answer.** Each response carries
  `x-credits-remaining` from the hold's check, `GET /v1/credits` answers the
  balance (ADR-0950), and an empty wallet answers 402
  `insufficient_credits` with a `top_up_url`.
- **Each charge names its key.** Every Autumn event carries the key's id and
  the model, so the dashboard shows usage per device by grouping events.
- **The free plan is a smaller wallet, not a shorter list of models.** The
  per-call cap and `ModelRequiresPaidPlan` go; a free allowance spent on a
  costly model runs out sooner.

## Consequences

- A call costs what it uses, through any client, so offering keys to every
  OpenAI tool is safe to price.
- **Code removed:** `AiModel.credits`, `FREE_TIER_MAX_CREDITS_PER_CALL`,
  `ModelRequiresPaidPlan`, the customer read the free-plan check made before
  every call, `checkAiCredits`, `trackAiTranscription`, and a reservation's
  `confirm()` without an amount.
- **Code added:** the rate table, the estimator, a pass-through stream that
  reads usage, and `confirm(credits)`.
- A second call on a nearly empty wallet can be refused while the first
  holds its ceiling, which the person sees as running out a little early.
- **To test before it is built:** whether Gemini's OpenAI-compatible
  endpoint returns usage when streaming; how Autumn settles a lock that has
  expired; and whether `overrideValue` takes a fraction, which decides
  whether rounding up is needed.
- Per-key spending caps (Autumn entities with usage limits) wait until
  someone asks for one; the events already name the key.

## Considered alternatives

- **Keep a fixed price per call.** Any client can send a call many times the
  size its price assumes.
- **Autumn's `trackTokens` and its model prices.** It charges after the call
  with no hold, so concurrent calls overspend; it stops at an empty balance
  and forgives the rest; it counts in Autumn's cost units rather than
  credits; and transcription by the minute does not fit it.
- **Track usage after the call with no hold.** The same overspend, and an
  empty wallet learns of it only after the provider is paid.
- **Hold a fixed amount and settle above it when a call costs more.**
  Settling above a hold is not documented; clamping output keeps every call
  within its hold.
- **Per-key wallets through Autumn entities now.** A second lifetime to keep
  in step with keys before anyone needs a cap.
