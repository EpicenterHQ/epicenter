# 0786. Every web app is online, and browser storage leaves the platform

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) at "A web app is either local only or online" and its local-only column: every web app is online; [ADR-0773](0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md) at `home` being "this browser's storage with no account": on the web, `home` is the team's repository, opened once the person signs in; [ADR-0784](0784-whispering-is-the-webs-local-app-and-messages-is-a-program-on-this-computer.md) at "Whispering is the web's one local app", its kept service worker, and browser storage called from the page: Whispering's web build is online, and no web app has a service worker or browser storage; [ADR-0779](0779-a-store-is-four-verbs-and-a-browser-recording-lands-whole.md) at where a browser recording lands: whole, at Stop, in the team's repository.
- **Relates:** [ADR-0780](0780-a-surface-uses-what-its-platform-gives-and-parity-is-not-a-goal.md) (each surface uses what its platform gives), [ADR-0781](0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md) (one build, which this keeps), [ADR-0770](0770-teams-own-repositories-and-sharing-is-membership.md) (consent chooses a team), [ADR-0785](0785-a-desktop-app-signs-in-to-sync-its-own-folder.md) (a desktop app signs in to sync).
- **Amended by:** [ADR-0788](0788-everything-in-a-folder-syncs-and-a-recordings-audio-is-kept-in-one-of-three-places.md) at a take landing whole in the folder: its note does, and its audio lands where the person keeps audio.
- **Unbuilt:** all of it, after Messages keeps its drafts in a directory (ADR-0784): Whispering's web build opening `home({ site, account })` and asking to sign in; deleting the browser storage store (`packages/folder/src/browser.ts` and its page-direct OPFS code), its conformance and smoke runs in Chromium and WebKit, `home()`'s browser branch, the private-window recovery page, `@epicenter/vite-config/offline` and Whispering's service worker and manifest; a storage limit for audio on the hosted plan.

## Context

ADR-0746 gave the web two kinds of app, local only and online, and a
design pass chose to pick between them by sign-in: no account, this
browser; signed in, the team's repository. The code never built that
switch. Todos, Honeycrisp, Capture and Vocab require sign-in on the web,
and only Whispering kept its data in this browser. Building the switch
means one page holding two places, reopening its folder on sign-in, and
copying the browser's notes across: a mode inside every web app.

Whispering's web build was the one local app, kept so it reopens and
records with no network (ADR-0784). Transcription on the web always needs
the network, with the person's own key or a hosted model; local models run
only in the desktop shell (`packages/transcription` is Rust). A recording
kept in one browser never reaches the person's desktop, phone, or another
browser. The repository store already uploads a file from the page as a
Git LFS object.

## Decision

**Every web app is online.** It asks the person to sign in, consent
chooses the team, and the app lives in that team's repository for it. No
page switches places, and no web app keeps data in this browser. A setting
or a key a web app holds stays in its settings store (ADR-0778).

**Whispering's web build is online like the rest.** A take lands whole at
Stop in the team's repository, and desktop Whispering shows it after its
next sync.

**Offline belongs to the installed app.** Recording, transcribing with a
local model, and working with no network are the desktop's. No web app has
a service worker.

**One sentence separates the surfaces:** the web reaches your team's
repository; your computer holds your folder. Both are one build
(ADR-0781).

## Consequences

- Browser storage leaves the platform: its store, its runs in two browser
  engines, the private-window recovery page, the offline module, and every
  "only Whispering" exception.
- A recording made on the web reaches every other surface.
- Using Whispering on the web needs an Epicenter account, even with the
  person's own transcription key; trying it in a browser starts with
  sign-in.
- Audio is the heaviest data the hosted service stores, so the hosted plan
  limits it.
- A clean break: recordings an earlier web build kept in a browser stay
  there, unread by this one.

## Considered alternatives

- **Chosen by sign-in.** One page holds two places and moves notes between
  them when the person signs in.
- **Whispering local, with history in this browser.** No account needed,
  but recordings never leave one browser, and the platform keeps browser
  storage, a service worker, and a recovery page for one app.
- **Whispering keeps nothing.** No account and no browser storage, but a
  reload loses a transcript.
- **A build per surface.** Brings back the seams and the drift ADR-0781
  removed, and each surface still branches on what it lacks.
