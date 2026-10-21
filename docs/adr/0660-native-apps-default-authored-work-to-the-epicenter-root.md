# 0660. Native apps default authored work to the Epicenter root

- **Status:** Accepted
- **Date:** 2026-10-21
- **Amends:** [ADR-0636](0636-an-app-opens-local-files-through-one-folder-handle.md) at allowing a standalone app's authored default inside AppData; [ADR-0644](0644-the-shell-assigns-a-native-windows-default-folder.md) and [ADR-0647](0647-a-native-window-edits-one-directory-bound-before-it-exists.md) at assigning standalone Todos its whole AppData directory. Their native shell ownership of the folder grant remains.
- **Restores:** [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md)'s visible authored-root rule for native application defaults, with its later changes to app installation and Epicenter's own records intact.
- **Relates:** [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) governs the host and CLI's shared AppData root; [ADR-0459](0459-sqlite-is-a-local-capability-for-derived-or-transactional-state.md) proposes when application SQLite earns its place; [ADR-0646](0646-a-native-app-hands-epicenter-a-directory-path-and-the-person-accepts-it.md) governs handoff of a directory outside the root. This decision defines no shared SQLite API.
- **Built:** The Epicenter host defaults each bundled app to a child of `~/Epicenter` (`~/Epicenter Dev` in development), creates that child when opened, and binds it to its window before loading the page.
- **Unbuilt:** Standalone Todos still opens its whole AppData directory. Standalone root selection, preservation of existing authored files when changing that default, and optional relocation UI remain to be implemented. No shared private-SQL API is required by this decision. Browser apps retain their current origin-local Folder.

## Context

The Epicenter host and standalone Todos run the same app page with different native defaults. Opening Todos in Epicenter creates and opens `~/Epicenter/Todos`. Opening standalone Todos creates and opens `~/Library/Application Support/so.epicenter.todos` on macOS. The `Folder` API is the same in both cases; the shell chooses the directory.

That difference made one question recur: if authored Markdown fills AppData, where does the app put SQLite? We considered `files/` and `private/` siblings inside every app home, an additional `.private` AppData sibling, and a reserved `.epicenter/sqlite/` subtree inside each authored folder. Each keeps some bytes apart, but adds a wrapper, a second hidden path convention, or a special exclusion rule to recover the simple statement that the opened folder is the person's work.

The current macOS Epicenter build does not enable App Sandbox. Its Rust shell can ordinarily create a direct child of `~/Epicenter` without a first-use folder picker, subject to operating-system file permissions. [Tauri capabilities](https://v2.tauri.app/security/capabilities/) still limit which window can invoke folder commands. A future sandboxed distribution would need its own directory-access design; [Apple requires App Sandbox for Mac App Store distribution but makes it optional for notarized distribution outside the store](https://developer.apple.com/documentation/Xcode/preparing-your-app-for-distribution). That future channel does not determine this native default.

## Decision

**Every native desktop Epicenter app defaults its authored Folder to a named direct child of the Epicenter root, whether the page runs inside the Epicenter host or in its own standalone shell.** On macOS the production root is `~/Epicenter`; development uses the separate `~/Epicenter Dev` root. Both shells must use the same durable app-folder name and authored-root policy for the same storage environment, including an explicit `EPICENTER_FOLDER_DIR` override. A display-name or bundle-identifier change must not silently select new work. The native shell creates a missing fixed default when the app is opened and binds only that child directory to the window before the page loads. The page calls `openFolder({ tables })` and never derives a filesystem path from its app identity.

```text
~/Epicenter/
  Todos/                         todos/<id>.md
  Whispering/                    recordings/<id>.md and recordings/<id>.<audio>
  Messages/                      drafts/<mode>-<digest>.md
```

The default name is a launch choice, not a portable dataset ID or a claim that only its namesake app may read the folder. Another app may deliberately open the same folder with its own schemas. A person may choose another existing directory; the fixed default does not silently replace that choice or a missing chosen directory. The Epicenter host already offers that choice. A standalone shell may add it without changing the default rule.

**AppData is for app-managed local state outside the authored Folder.** Examples include connection mirrors, search indexes, local SQLite databases, pending service operations, and machine preferences. Credentials stay in the appropriate keychain. SQLite is optional: the app developer decides whether a database is needed and whether its rows belong to an installation, an account, a service connection, or a particular folder. A host serving several apps partitions private state by stable app owner under its data root; a standalone Tauri app can use its own bundle-scoped AppData. Host-operated CLI apps such as Local Books retain [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md)'s shared-root convention. Database names and further partitions follow the owning capability, not the authored folder's name by default. A new hosted partition must not reuse a directory occupied by an older installed-app clone merely because its name resembles an app ID.

```text
authored Folder: ~/Epicenter/<App>/                 visible files; eligible for Git by its rules
private state:   <runtime AppData>/<app scope>/     optional databases and device settings
```

AppData does not mean disposable. A downloaded provider mirror may be rebuilt; a pending send or offline edit may be the only durable copy of user intent. The app owns retention, backup, migration, and recovery for each database. If data must follow the person across devices, the app must define that transfer explicitly; placing a SQLite file in AppData neither synchronizes it nor makes it safe to erase. An intentionally authored SQLite file may still be placed in a Folder as a normal user file. The rule concerns application-managed databases.

Ordinary authored records remain authoritative in the Folder, and every shell opening it must be able to interpret them without another shell's private database. A capability may keep durable transactional intent in AppData only with an explicit owner, invariant, and recovery path; opening the same Folder in two runtimes does not share their AppData. Intent that must prevent a second action on shared authored rows belongs with those rows or needs an explicit cross-runtime protocol. Messages currently keeps draft text and send-recovery state in Folder Markdown, for example.

**This is a native desktop default, not a browser filesystem promise.** A website opens its origin-local Folder and cannot silently create `~/Epicenter`. Synchronization may connect that local Folder to a remote Git repository, but sign-in and synchronization are not prerequisites for saving. The location of a native authored folder does not imply that every byte in it is committed or synchronized: ordinary Git ignore policy can leave a recording local while keeping it visible beside its Markdown.

## Consequences

- A standalone and a hosted launch of the same app open the same authored directory by default when their storage environment and root override match. The Folder's save lock remains beside its canonical directory, so both shells and the CLI coordinate file writes despite separate AppData roots. Each view must still refresh external changes according to the Folder's policy.
- First use needs no folder-selection step in the current unsandboxed macOS distribution. A sandboxed distribution would need a user-selected root or a different supported access mechanism, and must prove persistence across launches before making this promise.
- Folder discovery, Finder access, Git tooling, backup, and agent editing all begin at one visible root. Private databases need no reserved child name or Folder-wide exclusion rule merely to stay out of authored capture.
- Switching standalone Todos from AppData must preserve existing work. Detect authored files before opening a fresh `~/Epicenter/Todos`; unrelated runtime files do not prove there is work to migrate. If the target already holds work, do not merge automatically. Present a deliberate move or continued opening of the old directory. While the old AppData directory remains an authored Folder, keep new private databases outside that opened root. The directory handoff in ADR-0646 remains useful for this legacy location and for future chosen folders outside the root; opening the new default in Epicenter should use its existing root listing rather than create a duplicate shortcut.
- This decision changes no files on disk by itself. Current standalone behavior remains as documented until its shell and transition path are implemented.

## Considered alternatives

- **Keep standalone authored files in AppData.** Installation is easy, but the same app has two default homes, and a person's Markdown is hidden among machine state. SQLite then needs another partition or an exclusion rule inside the Folder.
- **Require `files/` and `private/` below every app root.** Directory placement separates them, but adds a wrapper around the readable work and moves hosted defaults away from the root the Folders window already scans.
- **Reserve `.epicenter/sqlite/` inside every Folder.** This colocates databases with documents, but requires Folder, Git capture, incoming sync, and ordinary file tools to agree on a hidden exclusion boundary. It also gives a folder ownership of account or provider databases that may outlive or span several folders.
- **Require a picker on every first launch.** It accommodates arbitrary locations, but adds onboarding to a fixed default the current unsandboxed native shell can create directly.
