# Folder workflow review, 2026-10-19

This review compares local opening, remembered paths, native CLI packaging, and
Capture-to-Vault review. It records the reasoning behind the accepted opening
and CLI decisions, not a claim that their interfaces have shipped.

Apps save useful work independently. Compatible apps and agents use accessible
files in place. Git exchanges copies across devices. Epicenter can help a person
find and resume folders. An editorial workflow develops captured material into
writing; a folder list does not perform that judgment.

## Landing

- [Opening](adr/0636-an-app-opens-local-files-through-one-folder-handle.md):
  app-chosen defaults, one root per handle, and visible
  failure when an established location is missing.
- [Remembered paths](adr/0641-epicenter-remembers-folders-as-machine-local-paths.md):
  one optional machine-local list shared by Epicenter desktop and CLI.
- [CLI selection](adr/0642-each-desktop-app-selects-its-cli-independently-of-the-terminal.md):
  matched private executables and explicit public terminal installation.

The accepted composition, optional-service, and desktop-deferral decisions
already cover the broader direction. No additional umbrella ADR is needed.
No runtime code or current CLI help changes in this landing.

## Nouns that remain

The counting basis is semantic distinctions needed to explain opening, saving,
synchronizing, and returning to work, including client packaging. It excludes
Git object internals, billing, inference-provider internals, and product-specific
Capture and Whispering state. The groups below organize 23 distinctions; they do
not make them six concepts.

| Group | Concept | Meaning |
| --- | --- | --- |
| Clients | App | The product behavior over saved work. |
| Clients | Runtime | The environment supplying storage and native mechanisms. |
| Clients | CLI executable | The program invoked privately by an app or selected publicly for terminal use. |
| Local access | Folder handle | One opened lifetime over rooted local files. |
| Local access | Directory | A native filesystem location another disk editor can access. |
| Local access | Browser store | Origin-private local data; not a Finder directory. |
| Local access | Path | An address relative to a handle, or an explicit absolute directory at native opening. |
| Local access | File | The source bytes, including material no selected table interprets. |
| Interpretation | Schema | A reader's expectations for frontmatter. |
| Interpretation | Table | A view over Markdown rows in a named directory. |
| Interpretation | Row | One Markdown file interpreted as fields and body. |
| Interpretation | Diagnostic | A named parsing or schema problem with accessible source. |
| Returning | Remembered path | A machine-local shortcut; no ownership, permission, or remote binding. |
| Exchange | Repository | Git history and configuration, separate from local file access. |
| Exchange | Clone | An independent local copy with its own edits. |
| Exchange | Remote | The destination for optional Git exchange. |
| Exchange | Grant | Permission to perform specified operations; a location alone grants none. |
| Information preservation | Draft | Input not yet acknowledged as saved. |
| Information preservation | Starting source | The exact source an edit began from. |
| Information preservation | Save | Acknowledged local persistence; no implied commit or upload. |
| Information preservation | Commit | A Git version; no implied remote receipt. |
| Information preservation | Sync attempt and status | Exchange and its outcome, distinct from the last local save. |
| Information preservation | Change notification | A reason to read again; it does not replace an unsaved draft. |

These distinctions survive because concrete failures separate them. Sign-out
changes authorization without selecting new local work. A folder move makes a
path stale without changing the contents. A browser copy can contain unsent
edits absent from another clone. A successful local save can precede a rejected
push. A schema disagreement must not erase the underlying source.

## Names and boundaries that collapse

| Competing or inherited model | Destination | What disappears or changes |
| --- | --- | --- |
| Public `Dataset`, `Repository`, and `Folder` as competing app handles | One public `Folder` handle | No second public storage owner; repository retains its Git meaning. |
| Universal local ID, app identity, and folder/scope ID as data addresses | Native directory or browser-local selection | No universal registry, clone-ID collision rule, or required data-identity marker. Platform app identity still exists. |
| Own versus foreign folder | Explicit location plus caller schemas and access grant | No schema-publication entitlement based on the app name. |
| Declaration, description, shape, and lens as interpretation nouns | Schema; schema file when stored as JSON | No extra reader configuration object with an independent lifetime. Existing source symbols remain until migrated. |
| App integration, registration, and authoritative catalog for returning to files | Remembered path | No standalone app startup dependency on Epicenter preferences. |
| Folder scan plus outside-folder registry | Explicit openings and one remembered list | No required shared parent or second discovery source. |
| One folder per app forever | One root per handle | No artificial ban on review across folders. Ordinary app UI can still use one handle. |
| One binary shared by every app and terminal | Matched private copies and an explicit public selection | No version discovery or last-launched-app ownership of the terminal command. |
| Capture promotion protocol and writing destination registry | Review workflow over accessible source and destination files | No required app-to-app messaging, synthetic combined repository, or automatic source cleanup. |

An existing product module named `Workspace` or `Library` is not automatically
another storage abstraction. Inspect its actual responsibility before deleting
or renaming it. Qualified inference configuration and sync destinations also
remain different things; hiding them behind `Connection` would obscure policy.

Most of the legacy ownership and installer removals were already selected in
accepted ADRs 0608, 0611, 0632, and 0633. This pass must not claim them again as
new savings. Remembered paths add one convenience concept. Private/public CLI
selection changes executable ownership; terminal-command lifetime and repair
still exist.

## Methods and command grammar

The opening sketches name the planned API, not current exports:

```ts
// Browser: reopen this origin's local work.
openFolder({ tables });

// Standalone native: the app supplies its default or a chosen directory.
openFolder({ directory, tables });

// Later runner: its native adapter uses the directory granted to the window.
openFolder({ tables });
```

The shared handle provides files, table views, changes, synchronization status,
and closing. This review does not invent exact replacement write, sync-connect,
or event method signatures. Starting-source and local-save guarantees must
survive their implementation.

```text
epicenter folders add <directory>
epicenter folders list --json
epicenter folders forget <directory>
epicenter open <directory>

epicenter check <directory>
epicenter query <directory> [<sql>]
epicenter status <directory>
epicenter sync <directory>
```

The plural group changes Epicenter's collection of remembered paths. The
top-level path verbs act on files or Git. `add` requires an existing directory;
`forget` changes only the list. Singular `folder` and top-level `remember` are
plausible spellings but remove no responsibility. Do not ship aliases merely to
preserve both sketches.

Current `commands.ts` has 22 commands, 17 visible. The four proposed commands are
absent from that implementation, although an older ADR reserved `open`.
Recording the grammar deletes no runtime commands. Existing retirement plans
and future additions need separate implementation accounting.

## Costs and alternatives

A UUID catalog could coordinate relocation across apps. It would also require
copy-versus-move semantics, identity collision handling, registry recovery, and
location reconciliation. Explicit path repair is the smaller promise here.

App-data defaults reduce first-launch decisions but make authored work less
visible. Reveal, backup guidance, and first-use versus missing-location handling
remain real product work. An Epicenter bookmark cannot reconfigure its source
app after a move.

Explicit terminal installation avoids a second release channel now. Moving its
selected bundle can break the terminal command and Git credential helper.
Explicit reinstall is the repair. Installer guards remain necessary; only
automatic launch-time selection disappears.

Matched private executables do not settle shared-state compatibility. Clients
sharing files need compatible save protocols. Clients sharing a rotating token
need the same credential identity and refresh lock. The packaging decision records
that invariant without inventing a shared-sign-in experience.

## Capture-to-Vault example

A phone capture first needs sync or export before a desktop agent can inspect
it. The agent can then read Capture and Vault, discuss a thought, and save the
result under Vault's conventions. Vault's current `AGENTS.md` says ordinary
extraction records the destination beside the contributing source and leaves
that source in place; only an explicit migration pass may retire it. That is a
workflow rule, not immutable Capture history or a folder-engine feature.

No source cleanup, provenance format, or review-state schema becomes universal
Epicenter policy. Compatible apps may also deliberately share one disk folder;
the two-folder example does not prohibit that arrangement.

## Review result and next evidence

A fresh Codex reviewer and read-only Claude Opus reviewer first explored the
outcome independently, then challenged the concrete proposal. Claude's initial
alternative removed app use of the CLI and introduced a new native history
runner, mandatory separate CLI distribution, and shared-root scanning. The
focused challenge rejected those costs: a private bundled CLI satisfies native
Git needs without a desktop or terminal installation dependency.

The reviews retained missing-location failure, source retention under the
destination workflow, credential-helper migration, and shared-state
compatibility. They corrected their initial deletion counts: already-chosen
retirements are not new savings from these decisions.

For implementation in either chat, use the three accepted decisions and this
inventory as the common direction. Bring concrete counterexamples and caller
evidence back to the owning record. Reopen a decision when that evidence changes ownership,
lifetime, information preservation, or public behavior. Repeating full panels to
obtain agreement is not a completion condition.

The next useful proof is a complete path: create and reopen account-free work,
connect existing local work to a chosen remote without losing either side,
reach it on desktop, and develop one thought into Vault while retaining its
source. Native missing-folder and concurrent-writer checks accompany the native
opening implementation. These are future verification tasks, not checks passed
by this documentation landing.
