# 0892. The CLI releases to npm, and Whispering 8 is a new install with its own update address

- **Status:** Proposed
- **Date:** 2026-11-13
- **Relates:** [ADR-0873](0873-the-command-is-epicenter-cli-and-it-supplies-epicenter-app-to-every-app.md) (`@epicenter/cli`), [ADR-0875](0875-a-package-is-published-when-an-app-outside-the-monorepo-imports-it.md) (what is published), [ADR-0890](0890-a-programs-folder-is-its-own-and-holds-only-what-its-apps-contract-declares.md) (Whispering's folder), [ADR-0891](0891-this-repository-holds-the-runtime-and-programs-and-every-starter-is-a-repository-of-its-own.md) (programs in this repository).
- **Unbuilt:** all of it: the release workflows, the npm packages per platform, Whispering 8's update manifest, and its import from Whispering 7.

## Context

Shipped Whispering checks
`releases/latest/download/latest.json` for updates: at
`braden-w/whispering` (v6.5, v7.0; that archived repository's file offers
7.5.1), at `epicenter-so/epicenter` (v7.2 to v7.5.1) and
`epicenter-md/epicenter` (v7.5.5), both of which GitHub redirects here, and at
`EpicenterHQ/epicenter` (v7.9 on). GitHub marks each new release Latest unless
told otherwise, and v7.11 shows "Failed to check for updates" when the check
fails (`check-for-updates.ts` at `v7.11.0`). Its identifier is
`com.bradenwong.whispering`; the current tree says `so.epicenter.whispering`.

Whispering's users are technical, and Whispering 8 is rebuilt from `v7.11.0`
as reference with a different folder and record format.

## Decision

**The CLI releases to npm. Whispering 8 is a new install, with its own
identifier and update address; it imports v7.11's recordings on request and
nothing else.**

| What ships | Where | Tag |
| --- | --- | --- |
| Whispering | a GitHub Release with its bundles and `whispering.json` | `v8.0.0` |
| `@epicenter/cli` | npm: `@epicenter/cli` and one package per platform | `@epicenter/cli@0.2.0` |

- **Whispering 8 is `so.epicenter.whispering`** and reads updates from
  `releases/latest/download/whispering.json`. People grant the microphone and
  Accessibility again.
- **Each Whispering release also carries v7.11.0's own `latest.json`,
  unchanged,** so every v7 install reads that it is up to date and shows no
  error.
- **"Import from Whispering 7"** copies v7.11's Markdown recordings from
  `~/Library/Application Support/com.bradenwong.whispering` (and its
  equivalents) into the program's folder. Settings and API keys are entered
  again. A person on a v7 older than 7.11 opens 7.11 once first, which moves
  its recordings into files.
- **The CLI never creates a GitHub Release,** so Latest is always
  Whispering's. It runs on macOS and Linux, on arm64 and x64: `@epicenter/cli`
  holds a `/bin/sh` launcher and names each platform's package as an optional
  dependency with `os` and `cpu` fields, with no postinstall script.
- **Tags keep the conventions in use:** `v<version>` for Whispering,
  `@epicenter/cli@<version>` for the CLI.
- **The `epicenter-so` and `epicenter-md` organization names stay
  registered,** since redirects from them carry v7.2 to v7.5.5 installs.

## Consequences

- Stars, issues, and releases stay in one repository.
- Moving from v7 to v8 is a download, a permission prompt, and one click to
  import; v7 is then deleted by hand.
- Whispering 8 carries no v7 storage code; the importer reads files only.
- A second program that updates itself from this repository needs a manifest
  of its own name and the same Latest; that holds while every such program
  releases together or reads a fixed path instead, decided when one ships.
- Windows hosts are not supported by the CLI; Whispering ships for Windows.

## Considered alternatives

- **Keep `com.bradenwong.whispering`, its key, and the v7 update address.** An
  update in place, at the cost of reading v7's WebView storage, an untested
  Windows installer path, and Latest reserved for Whispering for as long as
  any v7 runs.
- **A v7.12 bridge release.** A release whose only job is moving data a
  technical person moves with one click.
- **Let v7's check fail.** An error toast at every v7 launch.
- **A release-only repository per program.** Splits stars and adds a
  repository per program.
- **New tag conventions (`whispering-v8.0.0`, `cli-v0.2.0`).** A third and
  fourth convention beside 185 `v*` tags and `@epicenter/cli@0.1.0`.
