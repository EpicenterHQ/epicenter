---
name: autumn
description: 'Autumn billing in Epicenter: `autumn.config.ts`, `autumn-js` credit checks, `atmn` CLI, plan gates, and metered AI usage. Use when changing billing, pricing, credits, plan access, refunds, or usage events.'
metadata:
  author: epicenter
  version: '1.2'
---

# Autumn Billing Integration Guide

## Reference Repositories

- [Autumn](https://github.com/useautumn/autumn): Usage-based billing platform
- [Autumn TypeScript SDK + CLI](https://github.com/useautumn/typescript): `autumn-js` SDK and `atmn` CLI
- [Autumn Docs](https://docs.useautumn.com)

## Upstream Grounding

When Autumn Product, ProductItem, Feature, Entitlement, Customer, CustomerProduct, pricing, credit checks, SDK calls, CLI behavior, or usage-event semantics affect correctness, use source-backed grounding before relying on memory. If DeepWiki MCP is available, ask a narrow question against `useautumn/autumn`; if it is unavailable or the repo is not indexed, use upstream source or official docs directly. For `autumn-js` SDK or `atmn` CLI behavior, verify against the installed package, `useautumn/typescript`, or official docs. Treat DeepWiki as orientation, then verify decisive details against local billing code, installed types, source, or official docs before changing code.

Skip DeepWiki for hosted-only Epicenter billing boundaries already documented in `AGENTS.md` and below.

---

## Domain Model Checks

- Use Autumn's current nouns precisely: Feature, Entitlement, Product, ProductItem, Price, Customer, and CustomerProduct.
- Validate ProductItem shapes before pushing config. Most failures come from invalid interval combinations, missing linked features, or price/reset variants that do not match the feature type.
- Decide fail-open versus fail-closed behavior for `check()` errors at each endpoint. AI credit charging should fail closed before expensive provider calls.
- If Stripe webhooks or CustomerProduct state transitions are touched, make the handler idempotent around retries.

---

## Naming Conventions (CRITICAL)

**All IDs use `snake_case`.** This is Autumn's explicit convention.

Feature IDs should be **descriptive** (not abstract tier numbers) and **ecosystem-scoped** (not tied to a single app feature like "chat"). The metered features represent model cost tiers that any AI feature can consume.

```typescript
// CORRECT: descriptive, ecosystem-scoped
feature({ id: 'ai_fast', ... })
feature({ id: 'ai_standard', ... })
feature({ id: 'ai_premium', ... })
plan({ id: 'pro', ... })
plan({ id: 'credit_top_up', ... })

// WRONG: tied to a single feature ("chat")
feature({ id: 'ai_chat_fast', ... })

// WRONG: abstract tier numbers (Autumn convention prefers descriptive)
feature({ id: 'ai_tier_1', ... })

// WRONG: kebab-case
feature({ id: 'ai-fast', ... })
```

---

## Feature Types

| Type | `consumable` | Use Case | Example |
|------|-------------|----------|---------|
| `metered` | `true` | Usage that resets periodically (messages, API calls) | AI model invocations |
| `metered` | `false` | Persistent allocation (seats, storage) | Team seats |
| `credit_system` | n/a | Pool that maps to metered features via `creditSchema` | AI credits |
| `boolean` | n/a | Feature flag on/off | Advanced analytics |

**Credit systems** require linked `metered` features with `consumable: true`. Each linked feature has a `creditCost` defining how many credits one unit consumes.

```typescript
export const aiUsage = feature({
  id: 'ai_usage',
  name: 'AI Usage',
  type: 'metered',
  consumable: true,
});

export const aiCredits = feature({
  id: 'ai_credits',
  name: 'AI Credits',
  type: 'credit_system',
  creditSchema: [
    { meteredFeatureId: 'ai_usage', creditCost: 1 },
  ],
});
```

### Proportional Billing

Instead of multiple metered features with fixed `creditCost` per tier, use a **single metered feature** with `creditCost: 1` and vary the `requiredBalance` at runtime.

This gives per-model cost precision without cluttering the Autumn dashboard with dozens of features.

**How it works**: Autumn's `check()` with `sendEvent: true` uses `requiredBalance` as the deduction amount. With `creditCost: 1`, passing `requiredBalance: 5` deducts exactly 5 credits from the pool.

```typescript
// Each model's cost is its `credits` in the model catalog
// (`AI_MODELS` in packages/ai/src/providers.ts), not autumn.config.ts.

// Dynamic deduction
const { credits } = MODELS_BY_ID[model];
await autumn.check({
  customerId,
  featureId: 'ai_usage',      // single feature for all models
  requiredBalance: credits,    // varies per model
  sendEvent: true,
});
```

**Refund on error**: Use `track({ featureId: 'ai_usage', value: -credits })` to refund the exact amount.

**Blocking models**: A model absent from `AI_MODELS` is refused as `AiChatError.UnknownModel`. On the free plan, a model whose `credits` exceed `FREE_TIER_MAX_CREDITS_PER_CALL` is refused as `AiChatError.ModelRequiresPaidPlan` (`reserveAiChat` in `apps/api/worker/billing/service.ts`).

---

## Plan Structure

### Groups

Plans in the same `group` are **mutually exclusive**. Subscribing to a new plan in the same group replaces the old one. Autumn handles the Stripe subscription swap automatically.

- **Upgrade** (free → pro): Immediate swap with proration.
- **Downgrade** (pro → free): Scheduled for end of billing cycle.

### Add-ons

Plans with `addOn: true` **stack** on top of any plan. No group conflict.

### `autoEnable`

Plans with `autoEnable: true` are auto-assigned when a customer is created via `customers.getOrCreate()`. Use for free tiers. Only allowed on plans with no `price`.

### Plan items: `reset.interval` vs `price.interval`

The **intervals** are mutually exclusive, not `reset` and `price` themselves. A `PlanItem` is one of three variants:

**`PlanItemWithReset`**: Has `reset.interval`. If `price` is also present, it CANNOT have `price.interval`. Use for free allocations that reset periodically, optionally with one-time overage pricing.

**`PlanItemWithPriceInterval`**: Has `price.interval`. CANNOT have `reset`. The `price.interval` determines BOTH the billing cycle AND when the `included` balance resets for consumable features. Use for paid plans with usage-based overage.

**`PlanItemNoReset`**: No `reset`. Use for continuous-use features like seats, or boolean features.

```typescript
// Free plan: reset only, no price
// `reset.interval` controls when the 50 included credits refresh
item({ featureId: aiCredits.id, included: 50, reset: { interval: 'month' } })

// Paid plan: price.interval handles both billing AND reset
// The 2000 included credits reset monthly via `price.interval: 'month'`
// Overage beyond 2000 billed at $1/100 credits
item({
  featureId: aiCredits.id,
  included: 2000,
  price: { amount: 1, billingUnits: 100, billingMethod: 'usage_based', interval: 'month' },
})
```

**Key insight**: For paid plans, `included` + `price.interval` implies monthly reset. The `included` field's Zod description: "Balance resets to this each interval for consumable features." You do NOT need a separate `reset` field on paid plan items.

---

## SDK: `autumn-js`

### Initialization

```typescript
import { Autumn } from 'autumn-js';

const autumn = new Autumn({ secretKey: env.AUTUMN_SECRET_KEY });
```

Stateless: safe to create per-request. No connection pooling needed.

### Customer Sync (MUST be blocking)

```typescript
await autumn.customers.getOrCreate({
  customerId: userId,
  name: userName ?? undefined,
  email: userEmail ?? undefined,
});
```

**This call MUST be awaited (blocking).** Autumn's `/check` endpoint does not auto-create customers. The customer must exist before any `check()` call.

### Credit Check

```typescript
const credits = getModelCredits(data.model);
const { allowed, balance } = await autumn.check({
  customerId: userId,
  featureId: 'ai_usage',
  requiredBalance: credits,
  sendEvent: true,
  properties: { model, provider },
});

if (!allowed) {
  // Return 402 with balance info
}
```

**featureId** is always 'ai_usage'. The credit cost varies per model via the dynamic requiredBalance.

### Refund on Error

```typescript
await autumn.track({
  customerId: userId,
  featureId: 'ai_usage',
  value: -credits,  // Negative value = refund
});
```

Use when the operation fails after credits were already deducted (e.g., AI stream errors). Typically pushed to an `afterResponse` queue to avoid blocking the error response.

---

## CLI: `atmn`

### Setup

```bash
bun x atmn login       # OAuth login, saves keys to .env
bun x atmn env         # Verify org and environment
```

### Config File

`autumn.config.ts` at the project root. Defines features and plans using `atmn` builders:

```typescript
import { feature, item, plan } from 'atmn';
```

### Push/Pull

```bash
bun x atmn preview     # Dry run, shows what would change
bun x atmn push        # Push to sandbox (interactive confirmation)
bun x atmn push --prod # Push to production
bun x atmn push --yes  # Auto-confirm (for CI/CD)
bun x atmn pull        # Pull remote config, generate SDK types
```

### Data Inspection

```bash
bun x atmn customers   # Browse customers
bun x atmn plans       # Browse plans
bun x atmn features    # Browse features
bun x atmn events      # Browse usage events
```

---

## Environment & Secrets

| Key | Environment | Prefix |
|-----|-------------|--------|
| `AUTUMN_SECRET_KEY` | Sandbox (test) | `am_sk_test_...` |
| `AUTUMN_SECRET_KEY` | Production | `am_sk_prod_...` |

Use the **same key name** in both environments. Let your secrets manager (Infisical, etc.) swap the value per environment. Don't create separate key names for sandbox vs prod.

For Cloudflare Workers: `wrangler secret put AUTUMN_SECRET_KEY`

For local dev with Infisical: secrets are auto-injected via `infisical run --env=dev --path=/api -- wrangler dev`

---

## Middleware Pattern (Cloudflare Workers + Hono)

### Ensure Customer Exists

Run after `authGuard`, before any billing-gated routes:

```typescript
app.use('/ai/*', async (c, next) => {
  const autumn = createAutumn(c.env);
  await autumn.customers.getOrCreate({
    customerId: c.var.user.id,
    name: c.var.user.name ?? undefined,
    email: c.var.user.email ?? undefined,
  });
  await next();
});
```

**Why inline?** Cloudflare Workers don't expose `env` at module scope. The Autumn client must be created inside the request handler.

### Credit Gate in Handler

```typescript
const credits = getModelCredits(data.model);
if (!credits) return c.json(error, 400);

const { allowed, balance } = await autumn.check({
  customerId: c.var.user.id,
  featureId: 'ai_usage',
  requiredBalance: credits,
  sendEvent: true,
});

if (!allowed) return c.json(error, 402);
```

---

## Stripe Integration

- **Sandbox**: Built-in Stripe test account. No setup needed.
- **Production**: Connect via Dashboard → Integrations → Stripe (OAuth recommended).
- Autumn creates Stripe products/prices automatically when you `atmn push`.
- Autumn is the source of truth for customer state; Stripe handles payments.

---

## Common Gotchas

1. **`getOrCreate` must be awaited**: Fire-and-forget will cause `check()` to fail with "customer not found."
2. **`featureId` in `check()` is always 'ai_usage'**: The credit cost varies per model via dynamic `requiredBalance`, not featureId.
3. **`reset.interval` and `price.interval` are mutually exclusive**: not `reset` and `price` themselves. A `PlanItemWithReset` CAN have a `price`, but that price cannot have an `interval`. For paid plans, `price.interval` handles both billing and balance reset.
4. **`sendEvent: true` deducts atomically**: Don't call `track()` separately for the happy path. Only use `track({ value: -1 })` for refunds.
5. **All IDs are snake_case**: Autumn's pricing agent convention. Don't use kebab-case.
6. **`autoEnable` triggers on customer creation**: Not on first `check()`. Ensure the middleware calls `getOrCreate` before checking.
7. **Multiple keys per environment**: Autumn supports multiple active secret keys for rotation. Generate a new key, update secrets, then revoke the old key.
8. **Use proportional billing**: One metered feature (`ai_usage`) with `creditCost: 1` and dynamic `requiredBalance` per model. Per-model costs are each model's `credits` in `packages/ai/src/providers.ts`, not autumn.config.ts. This avoids cluttering the dashboard with dozens of features.

---

## Project Files

| File | Purpose |
|------|---------|
| `apps/api/autumn.config.ts` | Feature, credit system, and plan definitions |
| `apps/api/worker/billing/autumn.ts` | `createAutumnClient(env)` SDK adapter and provider error mapping |
| `packages/ai/src/providers.ts` | The model catalog, with each model's credit cost |
| `apps/api/worker/billing/service.ts` | Billing domain operations, reservations, dashboard DTOs, and storage sync |
| `apps/api/worker/billing/policies.ts` | AI credit charging and asset storage billing policies |
| `apps/api/worker/billing/routes.ts` | `/api/billing/*` routes and billing auth mount |
| `apps/api/worker/index.ts` | Cloud Worker composition and billing policy wiring |

---

## Resources

- [Autumn Docs](https://docs.useautumn.com)
- [Autumn Dashboard](https://app.useautumn.com)
- [GitHub: Autumn](https://github.com/useautumn/autumn)
- [GitHub: TypeScript SDK + CLI](https://github.com/useautumn/typescript)
- [API Keys](https://app.useautumn.com/dev?tab=api_keys)
