# 0328. Epicenter runs when you log in, and Pause is the only control it offers

- **Status:** Accepted
- **Date:** 2026-09-01
- **Unbuilt:** all of it. Epicenter adds itself to no login items, has no Pause, and opens Home when it starts. The tray exists; the autostart plugin is not registered, so enabling it once on first run is unbuilt too.
- **Amends:** [ADR-0323](0323-background-work-runs-in-the-host-and-a-window-is-for-looking-at.md) at one clause, which is withdrawn: "turning it off belongs to the application, in the application's own words", and the per-application "Pause syncing" it described. That clause was written to justify deleting a permission, and once the permission was gone nothing was left needing it. What a person wants is a machine want, not a mail want.
- **Relates:** [ADR-0327](0327-undelivered-work-is-an-outbox-and-that-is-where-a-failure-appears.md) (why the menu bar carries no counts, and what a person looks at instead), [ADR-0320](0320-removing-an-account-settles-what-it-owes-before-anything-is-deleted.md) (the verb for an account a person is finished with), and [ADR-0209](0209-epicenter-is-the-raw-view-beside-its-applications-not-a-shell-above-them.md) (Epicenter is beside its applications, which is why its menu is not a dashboard over them)

## Context

Background work runs in the host (ADR-0323), so Epicenter running is the promise
the product makes. Two questions follow immediately and neither had an answer:
when does it run, and how does a person stop it.

The first answer nearly became a setting. It should not, because there is
nowhere better for it to live than where it already lives: the operating system
owns the list of what starts at login, and it has a screen for it that a person
already knows how to find. A checkbox inside Epicenter would be a second face on
somebody else's setting.

The second answer nearly became a per-application feature, on the reasoning that
an application should own its own switch. That was wrong about what a person
wants. Nobody opens their mail application to stop their laptop from doing work.

## Decision

**Epicenter adds itself to login items once, and never again.** On first run, and
only then. If a person turns it off there, it stays off, because an application
that re-adds itself is the most resented thing on a desktop. The only thing
Epicenter stores is that it has done this once; the answer itself lives in the
operating system, which is also where a person changes it.

**Nothing opens at login.** A menu bar icon, the host, and each application's
background half. Home appears when a person asks for it. "Open at login" as a
phrase suggests a window a person did not ask for, and that is precisely what
this refuses.

**One Pause, for the machine.**

```txt
 ┌────────────────────────────────────────────┐
 │  Open Home                                 │
 │  Local Mail                                │
 │  ────────────────────────────────────────  │
 │  Pause                                     │
 │  ────────────────────────────────────────  │
 │  Quit Epicenter                            │
 └────────────────────────────────────────────┘
```

The icon dims while paused, and that is the entire reminder. Resume is the same
item. It stops every application's background half at once, because the want
behind it is a machine want: a battery, a tethered connection, a flight.

**Pause does not survive a restart.** It means "not right now", and a new login
is a new now. A person who wants Epicenter off for longer than that has the two
verbs the operating system already gives them.

**Reading still works while paused.** A window opens, mail is there, and triage
is recorded exactly as always. It simply is not delivered, and the application's
outbox says how much is waiting (ADR-0327), which is the application reporting a
person's own work rather than Epicenter reporting on itself.

**Quit stays, and it is last.** It is the operating system's verb and hiding it
would be worse than offering it. Pause comes first because Quit is what a
person's hand reaches for when they mean Pause, and a person who quits has
silently stopped their own mail delivery with a keystroke they use on every
other application.

**The menu carries no counts and no per-application status.** No "3 waiting", no
last-synced times, no health. That would make Epicenter the place a person
checks on Local Mail, which is the second face ADR-0327 refused: what a person
wants to know is whether their own work landed, and that belongs to the
application that owes it.

**There is no per-application pause.** An account a person is finished with is
removed (ADR-0320), which already exists and already says what it costs.
Anything between "stop this machine for now" and "I am done with this account"
has no person behind it.

## Consequences

- Epicenter stops being an application a person opens and becomes a thing that
  is running, which is what the outbox already assumed: an outbox that drains
  only while somebody watches it is not an outbox.
- Somebody will find Epicenter in their login items one day and be mildly
  annoyed. Their recourse is one toggle in a screen they already understand, and
  it is respected permanently.
- A person cannot pause one application while another keeps working. Nobody has
  asked for that, and the day somebody does it is a new decision rather than a
  gap.
- The menu bar stays a launcher and a switch, not a dashboard.

## Considered alternatives

- **A checkbox in Home's settings.** Rejected. It is a second face on a setting
  the operating system owns, and the state is not even ours to hold.
- **Ask once, at the first connected account.** Rejected, though it was close. It
  is one honest dialog, but it exists only to announce something the operating
  system will show anyway in a screen built for exactly this question.
- **Add nothing to login items and let a person find the setting.** Rejected. For
  most people the feature would not exist, and the promise the product makes
  would quietly not be kept.
- **Timed pauses: an hour, until tomorrow.** Rejected. Nobody means an hour. The
  want is "not right now", and a dimmed icon plus a filling outbox is a better
  reminder than a timer a person did not set on purpose.
- **A count in the menu bar.** Rejected by ADR-0327's reasoning, one level up: a
  person wants to know whether their work landed, not to watch a platform.
