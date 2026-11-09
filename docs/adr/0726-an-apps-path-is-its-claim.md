# 0726. An app's path is its claim

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03
- **Amends:** [ADR-0721](0721-an-apps-folder-is-derived-never-stored.md) at first launch read from AppData's absence, the first-launch collision choice, and "Locate…" / "Start a new folder": none remain; [ADR-0725](0725-an-app-reaches-named-roots-through-one-command-per-storage-operation.md) at `root_status`, `create_root`, and the `Ready`, `Missing` and `Disconnected` values: the shell states no status.
- **Unbuilt:** none.

## Context

ADR-0721 made an app's folder a derived path, `~/Epicenter/whispering`, and
kept three pieces of state around it: first launch, detected by the app's
AppData not existing yet, so a moved folder would not be recreated silently;
a collision check that asked before writing into a folder holding files the
app did not recognize; and "Locate…" / "Start a new folder" for a folder that
went missing later. ADR-0725 turned these into a status the shell reported,
`Ready | Missing { first_launch } | Disconnected`, which the page turned into
screens.

Every one of them answers a question about who owns a folder or where it
went. Under ADR-0721 and ADR-0722 the path answers both: the library root is
Epicenter's namespace, a folder moves with `epicenter move`, which leaves a
link at the path, and a folder kept elsewhere is a link at the path.

## Decision

**`~/Epicenter/<name>` belongs to the app named `<name>`.** Whatever is at
that path is that app's folder.

**An app opens its path, creating the folder when nothing is there.** The
same rule holds on every launch; nothing records whether a launch is the
first.

**A failure is shown plainly, with [Retry] and [Show in Finder].** A link at
the path whose target is gone fails to open, and the error says so: "This
folder is a link to a place that isn't available, such as a disconnected
drive."

**The app reads and writes only its contract's paths.** Files at its path that
the contract does not name are left untouched.

The one refusal of ADR-0725 stays: a data root whose resolved location is the
person's home folder, an ancestor of it, or the library root is refused at
startup.

## Consequences

- The first-launch flag, the collision dialog, "Locate…", "Start a new
  folder", `root_status`, `create_root`, and the status values are not built.
  Startup is: open the path, create it if missing, show any failure.
- A folder moved without a link leaves an empty folder at the path on the
  next launch. The moved data is intact where it was put; `epicenter move` and
  Epicenter's "Move…" leave the link that prevents this.
- Files someone else puts at an app's path are treated as the app's. The app
  ignores files outside its contract, so the cost is clutter, not damage.

## Considered alternatives

- **Detect first launch and ask before recreating a missing folder
  (ADR-0721).** State and two screens to protect a move that `epicenter move`
  already handles with a link.
- **Ask before using a folder with unrecognized files.** A dialog to defend
  a path no other program is meant to use.
