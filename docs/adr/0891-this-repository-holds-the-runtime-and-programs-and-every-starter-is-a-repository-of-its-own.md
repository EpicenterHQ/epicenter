# 0891. This repository holds the runtime and programs, and every starter is a repository of its own

- **Status:** Accepted (2026-11-13)
- **Date:** 2026-11-13
- **Relates:** [ADR-0843](0843-new-code-imports-nothing-from-the-waiting-product-which-leaves-by-deletion.md) (the old product leaves), [ADR-0866](0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md) (starters), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (this repository holds no apps), [ADR-0889](0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md) (programs).
- **Amended:** 2026-11-13, the same day. The hosted API stays, as a service: it is live and paid, and it holds the accounts and billing a hosted notes service would need ([ADR-0897](0897-hosted-notes-is-a-product-beside-epicenter-and-waits-for-a-month-of-evidence.md)). It was to leave with the old product.
- **Unbuilt:** `apps/api` moving to `services/api`, after which `apps/` is gone; the folder sync packages, which leave when neither Whispering nor the API imports them ([ADR-0843](0843-new-code-imports-nothing-from-the-waiting-product-which-leaves-by-deletion.md), steps 3 and 4); `EpicenterHQ/whispering-starter`.
- **Built:** 2026-11-13. `programs/whispering` and `sites/landing` moved; Honeycrisp, Local Books, and the PostHog proxy were deleted. The tag `before-0891-layout` marks the last commit with them in the tree.

## Context

`apps/` in this repository holds Whispering, the old product's apps
(Honeycrisp, Local Books, Messages), the hosted API, the website, and a
PostHog proxy. In Epicenter "app" means a folder `epicenter` runs, which none
of these is. Whispering's contract needs a home that `epicenter new --from`
can take as a starter.

## Decision

**This repository holds the runtime, the packages it is built from, programs,
services, and the website. Every starter, Whispering's included, is a
repository of its own.**

```txt
EpicenterHQ/epicenter
  packages/cli            the epicenter command
  packages/app            @epicenter/app, carried by the command
  packages/ui             components apps and programs copy
  programs/whispering/    the desktop program
  services/api/           the hosted API: sign-in, inference, billing
  sites/landing/          the website
EpicenterHQ/whispering-starter
  epicenter.ts  package.json  README.md
```

- **Whispering pins its starter** as a Git dependency at a tag, and imports
  the contract's types from it. During development, a local override points
  the dependency at a checkout beside it.
- **`apps/` becomes `programs/`** when the old product leaves.
  `apps/landing` moves to `sites/landing`;
  `apps/posthog-reverse-proxy` and the old product's apps leave with it.
- **`apps/api` becomes `services/api`.** A service is software someone else
  runs that holds the truth of its own data, as Gmail does. Whispering 7
  signs in, transcribes, and is billed through the API. It loses its folder
  sync routes (ADR-0843, step 3) and keeps sign-in, inference, and billing.
  The move changes the deploy workflow's path and the billing path in
  `AGENTS.md`, and waits for its own change.

## Consequences

- One rule for every starter: a repository, taken with
  `epicenter new <app> --from <repository>` and updated by a Git merge
  (ADR-0866). ADR-0877's "this repository holds no apps" holds without an
  exception.
- A change to Whispering's contract is two commits in two repositories: the
  starter's, then the program's pin.
- The directory names teach the nouns: nothing under `programs/` or
  `services/` is an app.

## Considered alternatives

- **The starter at `programs/whispering/starter/`, mirrored by CI to its own
  repository.** The contract sits beside the program, at the cost of a mirror
  job, two copies of the starter, and an exception to ADR-0877.
- **Keep `apps/`, Turborepo's convention.** It names Whispering with the one
  word this project defines differently.
- **`epicenter new --from <repository>#<subfolder>`.** `update` becomes a
  subtree merge, which ADR-0866 declined to own.
