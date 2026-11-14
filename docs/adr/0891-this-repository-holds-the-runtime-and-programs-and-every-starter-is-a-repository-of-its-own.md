# 0891. This repository holds the runtime and programs, and every starter is a repository of its own

- **Status:** Accepted (2026-11-13)
- **Date:** 2026-11-13
- **Amended by:** [ADR-0901](0901-an-app-is-inside-an-epicenter-or-outside-it.md) at "nothing under `programs/` is an app": nothing under `programs/` is an inside app.
- **Relates:** [ADR-0843](0843-new-code-imports-nothing-from-the-waiting-product-which-leaves-by-deletion.md) (the old product leaves), [ADR-0866](0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md) (starters), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (this repository holds no apps), [ADR-0889](0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md) (programs).
- **Unbuilt:** all of it: `programs/`, `sites/`, and `EpicenterHQ/whispering-starter`.

## Context

`apps/` in this repository holds Whispering, the old product's apps
(Honeycrisp, Local Books, Messages), the hosted API, the website, and a
PostHog proxy. In Epicenter "app" means a folder `epicenter` runs, which none
of these is. Whispering's contract needs a home that `epicenter new --from`
can take as a starter.

## Decision

**This repository holds the runtime, the packages it is built from, programs,
and the website. Every starter, Whispering's included, is a repository of its
own.**

```txt
EpicenterHQ/epicenter
  packages/cli            the epicenter command
  packages/app            @epicenter/app, carried by the command
  packages/ui             components apps and programs copy
  programs/whispering/    the desktop program
  sites/landing/          the website
EpicenterHQ/whispering-starter
  epicenter.ts  package.json  README.md
```

- **Whispering pins its starter** as a Git dependency at a tag, and imports
  the contract's types from it. During development, a local override points
  the dependency at a checkout beside it.
- **`apps/` becomes `programs/`** when the old product leaves.
  `apps/landing` moves to `sites/landing`; `apps/api`,
  `apps/posthog-reverse-proxy`, and the old product's apps leave with it.

## Consequences

- One rule for every starter: a repository, taken with
  `epicenter new <app> --from <repository>` and updated by a Git merge
  (ADR-0866). ADR-0877's "this repository holds no apps" holds without an
  exception.
- A change to Whispering's contract is two commits in two repositories: the
  starter's, then the program's pin.
- The directory names teach the nouns: nothing under `programs/` is an app.

## Considered alternatives

- **The starter at `programs/whispering/starter/`, mirrored by CI to its own
  repository.** The contract sits beside the program, at the cost of a mirror
  job, two copies of the starter, and an exception to ADR-0877.
- **Keep `apps/`, Turborepo's convention.** It names Whispering with the one
  word this project defines differently.
- **`epicenter new --from <repository>#<subfolder>`.** `update` becomes a
  subtree merge, which ADR-0866 declined to own.
