# 0189. Home launches applications into their own windows and stays open behind them

- **Status:** Accepted
- **Date:** 2026-07-30
- **Amended by:** [ADR-0209](0209-epicenter-is-the-raw-view-beside-its-applications-not-a-shell-above-them.md), which withdraws "stays open behind them", Home-as-shell, and the refusal of a fourth pane. The per-application windows this record decided are kept, and so are its one launchable list, its one launch verb, and its refusal of an installation UI. The fourth pane returns as `Data`, which is Epicenter's own job rather than another way to launch something. And by [ADR-0402](0402-a-window-label-is-identity-never-authority-and-the-capability-is-a-host-constant.md) at one consequence: "Its capability file is the only thing holding that line" is withdrawn; the host grants every native verb to every window, and Home's ownership of the launch verb is a fact about Home's UI.
- **Relates:** [ADR-0152](0152-epicenter-home-is-a-shell-above-workspaces.md) (Home owns navigation; this record decides its shape), [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md), [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md), [ADR-0180](0180-epicenter-has-one-host-owned-active-local-transcription-model.md), [ADR-0181](0181-every-app-receives-one-portable-epicenter-capability-handle.md), [ADR-0186](0186-an-app-reaches-epicenter-through-one-bundled-mit-client-it-installs-itself.md)

## Context

ADR-0152 gave Home navigation without deciding its shape, and nothing filled the
gap. Whispering was reachable only from the tray or a hand-typed
`epicenter://surface/whispering`, and an admitted catalog member (ADR-0179) had
no entry point at all. Home's own controls accreted into its header one at a
time: a tool popover, a New chat button, and a Local model toggle that expanded
model administration inline above the conversation.

Underneath that, opening a compiled surface and opening an admitted member were
two mechanisms with no shared entry point. Both are things a person opens, and
which one a given ID names is decided by a table the host already holds.

## Decision

Home is the shell a person keeps open. It lists what can be launched, launches
each into its own window, and stays open behind whatever it launched.

**One list, two sources.** Home lists the compiled applications this release
ships plus the members of the catalog generation this process selected at
startup. Both reach Home as one `{ id, title }` shape, so nothing downstream
branches on where an application came from. The list is not itself a catalog:
"catalog" keeps its ADR-0179 meaning, the immutable generation of admitted
folders, and a compiled application never enters it. Home itself is not in the
list, because it is the shell the list lives in, and neither is a
release-bundled placeholder document, because there is nothing behind it to
open.

**One Home-owned launch verb.** Home calls one native command with one ID. The
host resolves it and decides privately whether that means revealing a compiled
surface or opening an `app-` window. Launching again focuses the existing window
rather than creating a second one, and Home is never hidden to do it. The
command settles on the outcome of that window work, not on having scheduled it,
so a launch that fails gives the person a sentence instead of silence.

That verb is Home's, and no other window holds it. It is deliberately not the
`openApp(appId)` of ADR-0181: that operation is app-facing and targets an
admitted member only. The two stay apart so an application can never reveal
another application. ADR-0181's refusal to collapse `openHome(section)` and
`openApp(appId)` is unchanged and unamended by this record.

**Bun owns membership; Rust owns window mechanism.** The catalog stays exactly
where ADR-0179 put it: one immutable generation, selected once at startup,
served and enumerated by Bun. Rust keeps no copy of it and answers no question
about it. The launch command validates the ID's shape, refuses reserved surface
IDs that are not applications, and then builds a window; whether a folder was
ever admitted is not a question it asks. What keeps a made-up ID from arriving
is that Home only offers IDs from the authenticated list Bun served it, and what
makes a wrong one harmless is that the resulting window loads a URL Rust derived
itself and Bun answers 404. Two catalogs would mean two answers, so there is
one.

**Three panes.** Home has exactly three: Apps, Chat, Settings. Apps is the
native landing pane. Chat owns the assistant session and its own controls.
Settings owns host-level administration, starting with the one active local
transcription model (ADR-0180), which leaves the global header.

**Recovery is navigation, never a continuation.** An application whose
transcription route the host cannot run sends the user to Home's transcription
Settings through `openHome('transcription')` and nothing else: no callback URL,
no return token, no remembered caller, no automatic focus jump. Once local
transcription is ready, Settings offers the same ordinary launch action any
other surface would, because that is true then and would be true if the user had
arrived from nowhere.

**One honest degradation.** Home is also served to a plain browser and to a
remote device attached to the session (ADR-0080). Those documents cannot open
windows or administer device-local models, so they land on Chat and say where
those capabilities live instead of offering an action that would fail.

## Consequences

- An admitted application is reachable the moment it is admitted, and the tray
  and deep links become shortcuts rather than the only navigation.
- The frontend never models "compiled versus admitted". One list, one row, one
  verb, so a compiled application entering the catalog later is a host change
  with no user-visible event.
- Home's header stops being where controls land. A new capability picks a pane
  or it does not ship.
- Model administration moves one click further away and stops competing with the
  conversation for vertical space.
- The launchable set stays a host decision. A placeholder surface is invisible in
  Apps, and the host refuses to launch it even if asked by ID.
- Whispering can hand off a fix it cannot perform, and the user returns with one
  deliberate click rather than a protocol. Nothing records that they came from
  Whispering, so nothing can be wrong about it later.
- Home now has a launch verb that crosses the identity boundary ADR-0181 keeps
  closed for applications. Its capability file is the only thing holding that
  line, so widening it is a product decision, not a permissions fix.
- Nothing here decides installation, update, or removal UI. Those need real
  operations before they need a screen, and ADR-0179 deliberately left the
  registry questions open.
- A rail or sidebar is refused for now. Three panes fit a tab bar; a catalog
  large enough to need a rail is the evidence that would earn one.

## Considered alternatives

- **Calling Home's list "the catalog".** Rejected: ADR-0179 already gave that
  word to the immutable admitted generation, and reusing it for a presentation
  list would teach that a compiled application is something a user could admit
  or replace.
- **Reusing `openApp(appId)` as Home's launcher.** Rejected: that is the name
  ADR-0181 reserves for the app-facing operation, so widening it would make "an
  application can reveal a compiled surface" the default the day a `shell`
  namespace shipped.
- **Two commands with the dispatch in Home's frontend.** Rejected: the host
  already owns the table that answers which mechanism an ID needs, so putting
  the branch in the UI copies host knowledge into a window and gives a person
  two rows for one act.
- **Checking catalog membership in Rust before opening a window.** Rejected: it
  duplicates the one immutable generation ADR-0179 gave to Bun, and two owners
  of "is this a real app" is how they drift. The refusal costs nothing, because
  a non-member ID already resolves to a contained 404.
- **Letting the launch command queue like the tray does.** Rejected: queueing is
  right when nobody is waiting, and wrong when someone clicked. A window that
  appears after the next restart is not the thing that was asked for.
- **An applications popover in the header.** Rejected: it makes launching a
  transient menu act and keeps growing the header this record is collapsing.
- **A "Back to Whispering" affordance after setup.** Rejected: it requires
  remembering a caller, which is a continuation protocol. A launch action that
  is true whenever local transcription is ready needs no memory.
- **Hiding Apps and Settings in a browser.** Rejected: a remote device attached
  to the session is a real reader, and one shell that explains itself beats two
  shells that differ by host.
