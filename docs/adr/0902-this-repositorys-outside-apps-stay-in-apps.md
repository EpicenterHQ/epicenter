# 0902. This repository's outside apps stay in `apps/`

- **Status:** Accepted (2026-11-14)
- **Date:** 2026-11-14
- **Amends:** [ADR-0891](0891-this-repository-holds-the-runtime-and-programs-and-every-starter-is-a-repository-of-its-own.md) at its layout: `programs/`, `sites/`, and `services/` are withdrawn, and nothing moves out of `apps/`. Its rule that every starter is a repository of its own stands.
- **Amends:** [ADR-0901](0901-an-app-is-inside-an-epicenter-or-outside-it.md) at "`programs/` in this repository still names what it holds": this repository has no `programs/`. Its nouns stand.
- **Supersedes:** the records of the two deleted apps that still said `Accepted`: ADR-0061 to ADR-0064 and ADR-0072 for Local Books, and ADR-0087 and ADR-0411 for Honeycrisp.
- **Relates:** [ADR-0843](0843-new-code-imports-nothing-from-the-waiting-product-which-leaves-by-deletion.md) (the old product leaves by deletion), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (this repository holds no inside apps), [ADR-0899](0899-the-folder-sync-product-is-retired.md) (the product the deleted apps belonged to).
- **Unbuilt:** nothing.

## Context

ADR-0891 moved Whispering to `programs/` and the website to `sites/`, and
planned `services/api`, for one reason: "app" meant only a folder in an
Epicenter, so nothing in `apps/` here was an app. ADR-0901 then made every
app an inside app or an outside app, and Whispering is an outside app. The
reason for the move went with it.

The move was built once, on the branch `claude/adr-0891-layout`, and
measured there: 167 files renamed, and 57 others edited only to follow the
new paths. Those edits reached both Cloudflare deploy workflows, the Cargo
workspace, the version bump script, and seven check scripts. Two tests that
scan `apps/` stopped checking Whispering without failing. On `main`, 103
files outside `apps/api` name its path, the billing rule in `AGENTS.md` among
them, and that move had not started.

## Decision

**This repository's `apps/` holds outside apps, and nothing moves.**

```txt
EpicenterHQ/epicenter
  apps/whispering     an outside app that runs on your device
  apps/api            the server behind it: accounts and paid models
  apps/landing        the website
  packages/           the epicenter command, and what the apps are built from
~/Epicenter/apps/     inside apps, on the home
```

- **Where an `apps/` folder is says which kind it holds.** In an Epicenter
  it holds inside apps; in this repository it holds outside apps. No inside
  app lives here (ADR-0877).
- **Honeycrisp, Local Books, and the PostHog proxy are deleted.** They were
  apps of the retired product (ADR-0899). The tag `before-0891-layout` marks
  the last commit with them in the tree.

## Considered alternatives

- **`programs/`, `sites/`, and `services/`** (ADR-0891). Each directory would
  name one kind of outside app and hold one thing. The names taught a
  distinction ADR-0901 made minor, at the cost of every path a workflow,
  script, or record already names.
- **`apps/` for outside apps here and a new name for the folder in an
  Epicenter.** That renames `~/Epicenter/apps` on every home, and the constant
  `APPS` in `packages/cli/src/root.ts`, to avoid a collision the two
  locations already resolve.

## Consequences

- No deploy path, Cargo member, or script glob changes.
- A reader of this repository sees `apps/` and `packages/`, as in most
  monorepos, and `apps/README.md` says the apps here are outside apps.
- The Worker that was built from `apps/posthog-reverse-proxy` is still
  deployed, and the website still sends its analytics through it. Its source
  is at the tag.
- The folder sync packages stay until neither Whispering nor the API imports
  them (ADR-0843).
