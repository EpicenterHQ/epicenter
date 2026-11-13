# 0890. GitHub Releases here are Whispering's, the CLI releases to npm, and Whispering 8 keeps its identity

- **Status:** Proposed
- **Date:** 2026-11-13
- **Relates:** [ADR-0873](0873-the-command-is-epicenter-cli-and-it-supplies-epicenter-app-to-every-app.md) (`@epicenter/cli`), [ADR-0875](0875-a-package-is-published-when-an-app-outside-the-monorepo-imports-it.md) (what is published), [ADR-0889](0889-an-app-and-a-program-meet-at-the-apps-contract-and-a-programs-starter-lives-beside-it.md) (programs in this repository).
- **Unbuilt:** all of it: the release workflows, the npm packages per platform, and Whispering 8's importer.

## Context

Every shipped Whispering checks
`https://github.com/EpicenterHQ/epicenter/releases/latest/download/latest.json`
for updates and installs only what its built-in public key verifies
(`tauri.conf.json` at `v7.11.0`). GitHub's "latest" is the newest release
that is not a draft or prerelease, unless a release sets `make_latest`; a new
release is marked Latest by default. A CLI release published as a GitHub
Release would become Latest, carry no `latest.json`, and stop updates for
every installed Whispering.

Whispering 8 is rebuilt from `v7.11.0` as reference. Its identifier at
`v7.11.0` is `com.bradenwong.whispering`; the current tree says
`so.epicenter.whispering`. The identifier names the program's data directory,
the WebView storage where v7 keeps settings in `localStorage` and older
recordings in IndexedDB, and the app macOS grants the microphone and
Accessibility.

## Decision

**GitHub Releases in this repository are Whispering's. The CLI releases to
npm with a Git tag. Whispering 8 keeps v7's identifier, signing key, and
update URL, and imports v7's data itself.**

| What ships | Where | Tag | Marked Latest |
| --- | --- | --- | --- |
| Whispering | a GitHub Release with its bundles and `latest.json` | `whispering-v8.0.0` | always |
| `@epicenter/cli` | npm: `@epicenter/cli` and one package per platform | `cli-v0.2.0` | never a GitHub Release |

- **The updater URL does not change.** Whispering 8's endpoint stays
  `releases/latest/download/latest.json`, and its updates are signed with the
  key whose public half v7 carries, so v7 updates to 8 like any release.
- **The identifier stays `com.bradenwong.whispering`.** It is never shown to a
  person. Keeping it keeps v7's data directory, WebView storage, and granted
  permissions under Whispering 8.
- **Whispering 8 imports v7 on first run:** settings from `localStorage`,
  recordings from IndexedDB or v7's Markdown files, into `~/Whispering` and
  the program's own data directory (ADR-0889). The importer is deleted once
  v7 is no longer supported.
- **The CLI runs on macOS and Linux,** on arm64 and x64. Its npm package
  `@epicenter/cli` holds a `/bin/sh` launcher and names each platform's
  package as an optional dependency with `os` and `cpu` fields, so npm and
  Bun install only the matching binary, with no postinstall script.
- **A release is created by a workflow that sets `make_latest` itself:**
  `true` for Whispering, and no GitHub Release for the CLI.

## Consequences

- Stars, issues, and releases stay in one repository.
- A second program that updates itself would need a rule of its own: GitHub
  marks one release Latest per repository. Its updater would read a manifest
  at a fixed path instead, a decision for when that program exists.
- Whispering 8's code carries v7's storage keys until the importer goes.
- Windows hosts are not supported by the CLI; Whispering itself still ships
  for Windows.

## Considered alternatives

- **A new identifier, `so.epicenter.whispering`, with a v7.12 bridge release
  that exports settings and points the updater elsewhere.** Every person
  grants the microphone and Accessibility again, the Windows installer's
  behavior across the change is untested, and a release exists only to move
  data a same-identifier v8 can read directly.
- **Each program's updater reads a manifest committed to a `releases` branch,
  with a redirect on a domain first.** Solves several programs updating from
  one repository, which is not a problem yet.
- **A release-only repository per program.** A clean Releases page each,
  at the cost of splitting stars and adding a repository per program.
- **CLI releases as GitHub Releases with `make_latest: false`.** Works until
  one is created without the flag, which stops updates for every installed
  Whispering.
