# 0647. A native window edits one directory bound before it exists

- **Status:** Accepted
- **Date:** 2026-10-20
- **Amended by:** [ADR-0660](0660-native-apps-default-authored-work-to-the-epicenter-root.md) at standalone Todos's fixed default directory: it uses the same Epicenter-root child as hosted Todos. Window binding and directory admission remain.
- **Amended by:** [ADR-0652](0652-the-folder-plugin-opens-one-window-per-app-and-directory.md) at shell-owned identity and standalone Todos's fixed label: both shells use the plugin's app-and-directory opener.
- **Amended by:** [ADR-0649](0649-folders-json-selects-this-machines-folder-locations.md) at Settings' fixed records path and name-based protected-root descriptions: `folders.json` selects the records location independently of its name. Window binding and admission checks remain.
- **Amends:** [ADR-0644](0644-the-shell-assigns-a-native-windows-default-folder.md) at "Explicit Tauri opening by registered directory ID remains available for windows that deliberately read several folders" and at the native opener asking the shell for the window's assignment: the shell binds the window's directory before the window exists, and no page opens a folder by ID. [ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md) at registering each folder for the windows that may edit it, permitting another window later, and the first `grant_directory` creating an application's directory: the shell binds one existing directory to each window label, creates a fixed default at launch, and keeps no registry of folders.
- **Unbuilt:** remembering a picker choice across launches; direct opening from CLI or arguments; an editor window on a folder chosen in the picker; rearming a root's watch after the directory is deleted and made again while a window bound to it stays open; serializing saves between windows on nested roots.

## Context

Desktop pages named their folder. The shell registered each directory under
a scope, permitted windows into scopes, and handed each window a scope; the
page passed that scope to `grant_directory` and to every storage, change,
and recorder command. The Folders window was permitted into every listed
folder and switched one handle among them, which needed root-switching and
cache-identity code and a draft fence that froze input once it was left. A
draft that moved the lookup into startup still left a resource ID in page
code.

The person chose a separate editing window per folder.

## Decision

**Each native window that edits files has one existing directory for its
lifetime, which trusted Rust binds to the window's label before its WebView
exists.** Every folder and recorder command derives the directory
from the calling WebView, whose label Tauri supplies; a page passes only
folder-relative paths. `openFolder({ tables })` opens the calling window's
directory. A browser opens its origin's IndexedDB folder with the same call,
and Bun opens an existing directory at an explicit path. No opener falls back
to other storage.

`Folders` owns live bindings, root watches, and shutdown under one state
lock. It checks membership and inserts or removes a watch in that same
state; no reverse membership index, root count, separate registry, or
cross-lock callback protocol is needed. Watcher destruction and event
emission happen after unlocking. Several windows may still share one root
and one native watch. A watcher per window would multiply native watcher
and debounce threads for several views of the same folder.

`Directory::create` prepares a fixed default; `Directory::existing` resolves
an explicitly selected directory without creating it. Directory values own
no window lifetime. Shutdown refuses new bindings and page commands; it
does not prohibit trusted Rust from constructing a directory value.
Epicenter owns its app-plus-root label hashing; standalone Todos uses a
fixed label. The folder plugin accepts those Tauri labels without defining
the shell's window identity policy.

A live label is never bound again. The plugin removes a binding when its
window is destroyed, and a window whose construction fails is unbound. An
operation clones its directory when it is admitted, so a label reused later
cannot redirect it. The folder's save lock serializes publication across
native windows and other participating processes. The shell needs no
root-to-mutex map or second publication lock. A change event carries paths
and reaches windows bound to the watched canonical root. No catalog, scope,
or permission graph is kept. A root's watch lasts while a window bound to it
is open: closing the last such window stops it, and the next window to open
the root starts another.

Every writer waits up to ten seconds for the save lock. A native writer no
longer waits indefinitely behind an additional in-process mutex. A timeout
changes no destination and reaches the existing visible save failure and
retained-draft path.

Saving needs a writable parent for the root's sibling save lock and staging
directory. A chosen folder with a read-only parent can still open for reading;
failed saves keep the draft and show the error.

Ordinary launch prepares the established default and creates it when it is
missing: the application data directory for standalone Todos, and
`<folderDir>/Todos`, `Capture`, `Honeycrisp`, or `Whispering` in Epicenter.
Standalone Todos exposes only that fixed default in one `todos` window. It
ships no folder-selection or multi-folder workflow; opening Todos on another
folder belongs to Epicenter. Both use the same static page and native Folder
API. The page performs no app-data lookup: its invoking WebView selects the
binding held by its native process.

Settings is bound to `<folderDir>/so.epicenter`. Explicit selection is
native in Epicenter: the launcher's Choose folder picker, which Rust opens
and answers, or a direct child the Folders window listed, which Rust finds
again by name. A chosen directory must exist
and be a real directory; it is never created, and its parent may be a link.
Opening a folder opens or reveals the window for that app and canonical
directory, labelled by the app and a digest of the root, so one name in two
places is two windows. A bundled app cannot bind a root that overlaps
Epicenter's own data: `so.epicenter` or anything in it, its sibling save
staging directory, the machine-local app data directory or anything in it,
or a directory holding any of these. The
folder root and its parents hold `so.epicenter`, so they are refused; a root
there would sit above every default and listed folder, each with its own
save lock. The check compares the resolved root at admission, so a linked
parent or another spelling does not route around it then. A listed direct
child other than `so.epicenter`, and a directory outside these roots, still open. Other
nested roots remain possible, such as a chosen directory inside a listed
folder, and saves between windows on them are not serialized.

The Folders window is a launcher bound to no folder. Choosing a listed folder
opens that folder's editor window on the Folders build's `/folders/editor/`
route; the route selects the page and nothing else.

The incoming handoff and remembered-path workflow in ADR-0646 remains. Accepting
opens a separate editor before remembering the path. A remembered entry is a
shortcut, not a file permission: listing binds nothing, and reopening requires
fresh stored-path or this-run membership and rechecks the resolved directory.
A shortcut follows its stored path: a parent link retargeted to another safe
directory opens that directory in a new editor; existing editors keep their roots.
The handoff and the bundled launcher share one protected-overlap rule. The
editor for a listed folder does not apply it, so it may open `so.epicenter`.
The handoff's old `opened:<n>` scope map, returned
IDs, launcher file access, and folder switching disappear.

## Consequences

- A page selects no native root or scope. Tauri supplies the invoking
  window; another folder is another window.
- A window reads one folder. Whispering's connection rows in `so.epicenter`
  are read and saved by operation through the CLI, not as a second folder.
- The folder editor needs no root switching or cache identity. `FolderApp`
  owns the handle; the window's drafts settle when it hides and keep taking
  input.
- A bound directory that is gone is refused when the page opens it. Native
  launch prepares a missing fixed default. Epicenter may then reveal its
  existing window instead of building another.
- The page's shell commands lost their scope argument, and the generated
  bindings follow the Rust commands.

## Considered alternatives

- **Startup reads the selection and passes it to the opener.** Adds a
  page-visible handle and initialization protocol for the window's only
  directory. A resource ID scoped to the invoking WebView can preserve
  isolation, but this API needs no handle argument.
- **Store the directory in the WebView's native resource table.** Could
  replace the label map, but needs installation before the page's first
  command and native resource discovery. Watcher membership and cleanup
  still need an owner.
- **One window that switches among folders.** Needs a registry entry per
  folder for that window, root switching, and a draft fence.
- **The page passes a raw path that the shell checks.** The page would select
  roots; the check would become a permission graph.
- **A launch selection in a JavaScript global or the URL.** A custom startup
  protocol that the page could still read and resend.
- **Use persisted selections as live window context.** The existing
  `folders.json` remembers handoff shortcuts; picker choices are not saved.
  A shortcut does not identify which folder a concurrently open window
  edits. Persisting a window-to-folder map would add crash cleanup without
  removing the need for per-window context.
