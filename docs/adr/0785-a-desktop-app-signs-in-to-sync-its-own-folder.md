# 0785. A desktop app signs in to sync its own folder

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0781](0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md) at "the desktop's place is synced by Epicenter and uses none. Desktop Todos shows no sign-in because nothing it uses asks for an account": the desktop's place is a directory and uses no account, but the app syncs that directory itself and offers sign-in to do it.
- **Relates:** [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) (sync at the moments a person expects), [ADR-0751](0751-every-native-app-carries-one-sync-core.md) (every native app carries the core), [ADR-0731](0731-every-app-signs-in-as-its-site.md) (every app signs in as its site, which this keeps), [ADR-0770](0770-teams-own-repositories-and-sharing-is-membership.md) (consent chooses a team), [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) (a desktop app's team is its setting), [ADR-0740](0740-every-credential-an-app-holds-lives-in-its-own-place.md) and [ADR-0783](0783-a-secret-lives-in-the-apps-credentials-file-and-is-read-by-the-request-that-uses-it.md) (each app's credentials file).
- **Amended by:** [ADR-0787](0787-records-that-assumed-a-running-engine-or-a-build-time-choice-follow-0750-and-0781.md) at "no refresh needs a lock across processes": true of an app, not of the CLI.
- **Amended by:** [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) at the core running an app's sync: the sync package runs it in the page.
- **Unbuilt:** each desktop app's sync control offering sign-in, and `epicenter-account` in the Capture, Honeycrisp and Todos shells, which have an account in the page but no shell sign-in yet; the rest is ADR-0751's `tauri-plugin-epicenter`.

## Context

ADR-0781 said a desktop app's folder is "synced by Epicenter", so an app
that uses nothing hosted, such as Todos, shows no sign-in. That assumed the
Epicenter app syncs every app's folder, which ADR-0750 and ADR-0751 had
already replaced the day before: each native app links the sync core and
runs a round at its own moments, after its own saves. A round needs a
grant, so an app that syncs signs in.

Only the Epicenter app syncing would let Todos skip sign-in, but Epicenter
cannot see Todos save without a file watcher or a background service, both
of which ADR-0750 refuses; a save would reach other devices only when
Epicenter next opened or regained focus. One sign-in per computer, sharing
one credential file among every first-party app, became possible again
once ADR-0740 moved secrets out of the keychain, whose prompts were one of
ADR-0731's two reasons for refusing it.

## Decision

**A desktop app signs in to sync its folder and to use hosted services, and
nothing in it waits on sign-in.** Sync is something the app uses that asks
for an account. Todos offers sign-in in its sync control; until the person
signs in, its folder is local and complete, and the app runs no rounds.

**Consent chooses the team** whose repository the app's folder syncs with
(ADR-0770). The grant reaches that one repository, and the team is the
app's setting on this computer (ADR-0772).

**A sign-in serves one app.** Each app keeps its own refresh token in its
own credentials file and refreshes it alone. A person already signed in at
`epicenter.so` signs an app in with one click.

## Consequences

- An app syncs with no other program installed, right after its own saves.
- A person signs in once per app on each computer.
- No two processes spend one rotating refresh token, so no refresh needs a
  lock across processes, and reuse detection never signs every app out.
- Signing out of, or revoking, one app leaves the others signed in, and a
  stolen credentials file reaches one app's repository.
- First-party and third-party apps sign in the same way.
- Each app ships the core and the consent screen, from shared code.

## Considered alternatives

- **Only the Epicenter app syncs.** Apps that use nothing hosted lose
  sign-in, consent, and the core, but a save waits for Epicenter's next
  moment unless Epicenter keeps the watch service ADR-0750 deletes.
  Whispering and Vocab sign in for AI regardless.
- **One sign-in per computer (reopening ADR-0720).** The smoothest
  experience, but every first-party app shares one rotating refresh token
  and needs a lock across processes around each refresh; one stolen file
  reaches every repository; third-party apps still sign in per app, so there
  are two ways to sign in; and nothing can tell which program read the
  shared file, ADR-0731's other reason.
