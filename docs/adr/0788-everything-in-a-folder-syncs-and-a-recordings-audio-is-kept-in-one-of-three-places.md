# 0788. Everything in a folder syncs, and a recording's audio is kept in one of three places

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0779](0779-a-store-is-four-verbs-and-a-browser-recording-lands-whole.md) and [ADR-0786](0786-every-web-app-is-online-and-browser-storage-leaves-the-platform.md) at a take landing whole in the folder: its note does, and its audio lands where the person keeps audio.
- **Relates:** [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) (sync like save), [ADR-0744](0744-sync-diffs-state-because-agents-edit-state.md) (a round diffs the folder against the last agreed version), [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) (this computer keeps the rest), [ADR-0778](0778-a-page-connects-once-and-then-reads-synchronously.md) (the settings store), [ADR-0780](0780-a-surface-uses-what-its-platform-gives-and-parity-is-not-a-goal.md) (a capability a surface cannot give is absent), [ADR-0785](0785-a-desktop-app-signs-in-to-sync-its-own-folder.md) (sync needs sign-in).
- **Amended by:** [ADR-0789](0789-a-conflict-is-a-mark-on-its-note-resolved-in-the-repair-editor.md) at the marks: a note holding a conflict block also shows ⚠.
- **Amended by:** [ADR-0801](0801-records-from-0763-to-0800-agree-on-the-merge-rust-patching-marks-and-agents.md) at the synced and waiting marks: they are ✓ and ◌.
- **Amended by:** [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) at "Everything in a folder syncs": every visible file syncs; a hidden path does not.
- **Unbuilt:** all of it: Whispering's "Keep audio" setting and transcribing from the take in memory; audio kept in the app's storage, with Show in Finder, and removed when its note goes; a recording whose audio is elsewhere, shown as "Audio is on <computer>"; the shell reporting the paths waiting to sync after each save and round, and the synced and waiting marks; the app showing once that it is not signed in.

## Context

A person may want a recording's transcript on every device while its audio,
the heaviest and most private part, stays home or is not kept at all. Git
can leave a file in a folder out of sync through an ignore rule, but an app
toggle that writes one would be a second owner of the fact, in a file the
person, their own Git, and agents also edit, and would make a third kind of
file: in the folder, not synced. A person also wants to see whether an item
has reached their other devices. "Committed" and "pushed" are steps of one
round seconds apart, and showing them separately teaches Git's staging
model to answer a question nobody asks.

## Decision

**Everything in a folder syncs.** No app writes an ignore rule, and nothing
in a folder is local-only. Where a file lives decides where it goes.

**A recording's audio is kept in one of three places**, chosen by
Whispering's "Keep audio" setting, a setting on this computer:

| Keep audio | Where the audio is | What happens |
| --- | --- | --- |
| Don't keep | memory | the take is transcribed from memory and never written |
| On this computer | the app's storage on this computer | stays here and never syncs |
| Everywhere | the folder | syncs with its note |

The note, with its transcript, is in the folder in every case. The default
is On this computer. The web has no storage of its own (ADR-0786), so it
offers Don't keep, its default, and Everywhere.

**Audio kept on this computer is the app's to tend.** A recording offers
Show in Finder, and Whispering removes local audio whose note is gone,
whichever device deleted it. Another device shows the transcript and "Audio
is on <computer>".

**A person sees whether an item has synced, never Git's steps.** On the
desktop an item in the folder is synced when it matches what the server
holds as of the last round, and waiting when it changed since; the shell
reports the waiting paths after each save and each round, from the diff a
round makes. Local audio's mark is its place. An app that is not signed in
says so once, not on each item. The web shows no marks: a write there
lands on the server.

## Consequences

- No ignore rules, no patterns, and no third kind of file in a folder.
- By default, audio never leaves the computer that recorded it, and the web
  uploads no audio unless the person keeps it everywhere.
- A recording whose audio is on another computer can be read but not played
  or transcribed again here.
- Local audio is out of sight of agents and other apps, as the person chose.
- "Committed" appears nowhere a person reads; history stays automatic.

## Considered alternatives

- **An ignore rule Whispering manages** in `.git/info/exclude` or the
  committed `.gitignore`: two owners of one fact, and the committed form
  makes a person's privacy choice a team's policy.
- **Two places, Don't keep and Everywhere:** no local-only audio and none of
  its cross-device state, but no way to keep audio without uploading it
  while signed in.
- **Committed and pushed as separate marks, with a Commit action:** precise,
  and it brings Git's staging model to people who asked only whether their
  work is on their other devices.
