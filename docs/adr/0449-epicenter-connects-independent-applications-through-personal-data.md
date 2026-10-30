# 0449. Epicenter connects independent applications through personal data

- **Status:** Proposed
- **Date:** 2026-09-28
- **Amends:** [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) at mandatory shared desktop packaging; [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) at the refusal of standalone desktop products; [ADR-0180](0180-epicenter-has-one-host-owned-active-local-transcription-model.md) at machine-wide engine ownership; [ADR-0323](0323-background-work-runs-in-the-host-and-a-window-is-for-looking-at.md) at mandatory Epicenter ownership of standalone products' background work.
- **Relates:** [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) preserves client-owned replicas and authority synchronization; [ADR-0334](0334-a-deployed-app-is-a-trusted-app-because-deploying-it-was-the-consent.md) preserves explicit deployment as trust in the code.
- **Unbuilt:** general installed-tool folder registration and access to multiple folders, a verified local save barrier for every tool, replica addressing for concurrent products, and the synchronized-data inspector described below.

## Context

> Epicenter makes personal software that shares your data without requiring you
> to live inside one application.
>
> Use focused apps, inspect and manage your data in Epicenter, and build or
> modify tools of your own. Those tools can run inside Epicenter or become
> independent applications.

Epicenter's data workspace has a purpose even without a personal-tool runner:

> Use focused apps to do your work. Open Epicenter to see, organize, and work
> directly with the data they share. Pull it into files when you want to use
> your own tools.

Today `apps/epicenter` packages a Tauri core and Bun sidecar. Its
`src/applications.ts` combines compiled applications and an admitted catalog.
The local installer accepts built releases. Product windows share native
capabilities. Todos and Capture register separate desktop folders, each
granted to one window, whose pages run the folder engine over them
([ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)). Installed tools are parked.

The shared native core reduces distribution work, but couples product releases
and native failures. A useful personal tool need not become a native product
before someone can use it. A focused product need not remain inside Epicenter
to participate in the same data ecosystem.

## Decision

**Applications can run standalone or together in Epicenter. Epicenter desktop
manages shared personal data and runs trusted SPAs concurrently in separate
windows.**

| Product | Execution and ownership |
| --- | --- |
| Standalone applications, including Whispering | Own installation, native runtime, updates, credentials, persistent replicas, and any background work. They can run concurrently and do not require Epicenter desktop to remain open. |
| Epicenter desktop | Browses authorized synchronized datasets, manages synchronized preferences and its own device settings, and hosts concurrent application windows and shared native folder owners. |
| Personal tool | An explicitly installed, trusted SPA with its own window. Its session can remain open while other tools or Home are in use. It uses capabilities compiled into the host. |
| Shared packages and Rust crates | Reuse data contracts and native implementation across products. Importing code does not share running processes or loaded models. |

**The data workspace connects synchronized datasets to explicit file workflows.**

Signing in connects Epicenter's page-owned replicas to the account authority.
The data browser offers views over compatible datasets without requiring the
specialized applications to be open. It operates on its received data and
cannot see unsent edits held by another application.

```txt
account authority
       ↕ automatic synchronization
Epicenter's live local replica
       ↕ explicit pull / push
working folder
       ↕
editors, scripts, agents, Matter views
```

Pull previews and writes replica data into the working folder. Push previews
and applies file edits to the replica. Both require the person's confirmation;
neither verb is remote synchronization. Between these operations the folder
holds still. Pulling offline uses the data this replica has received, without
promising that another device has no newer edits.

Matter's `matter.json` describes fields and views over files. It does not
discover remote datasets or supply every application's rich-content codec.
`packages/matter-core` and `packages/app/src/data/artifact` provide relevant
building blocks; combining them into a generic signed-in data workspace still
requires compatible definitions, content codecs, and replica discovery.

A working folder exported from a synchronized dataset differs from a local
data folder whose files are canonical. In the latter, edits to files are edits to
the data, and a SQLite index can be rebuilt from those files. This record does
not require permanently local data to use Yjs or Markdown. It does not promise
that data folders, local databases, and synchronized replicas expose identical
editing capabilities or can be converted by changing an opening function.

Browsing data and working through files are useful workflows to test separately
from demand for hosted applications. A person can customize their workflow with
an editor, script, or agent before building an SPA. The personal-tool runner
extends this workspace; it is not its sole reason to exist.

A tool needing an independent runtime or additional native capabilities can
become a standalone application. Browser, hosted, and standalone builds may share source
when their capability requirements are satisfied. Each build must state its
supported capabilities; arbitrary native code is not portable through an SPA
bundle. Packaging still requires app identity, permissions, and update choices.

**An application starts independently of its container.**

> Start with a small tool. Give it its own application when it needs its own life.

Personal software should be easy to create and change; native packaging is an
available destination. Developers use their editor and an ordinary SPA
development server. Running inside Epicenter is optional, including during
development. A developer who needs global shortcuts, continuous recording, or
custom native code can start with a standalone application.

| Stage | Developer supplies | Foundation supplies |
| --- | --- | --- |
| SPA | UI, data definitions, application logic | Persistence and synchronization packages |
| Hosted tool | A compatible built SPA | A window and existing host capabilities |
| Standalone application | A thin Tauri shell around the same SPA | Shared native crates and build conventions |
| Native extension | App-specific Rust commands or background work | Reusable implementation without requiring an Epicenter host release |

The intended project shape keeps UI and data logic in `src/`; an optional
`src-tauri/` adds the standalone shell. Custom Rust extends that application's
binary, not the running Epicenter host. A custom command makes a build dependent
on that capability unless another target supplies an alternative implementation.

Changing packaging preserves the logical dataset identity. For synchronized
data, the standalone application opens its own persistent replica. Unsynchronized
hosted edits require either synchronization before transfer or an explicit local
export/import path; a packaging command does not move the data. For file-backed
data, either shell can reopen the same selected folder after the previous native
process releases it. The first proof must run one SPA both hosted and standalone
without rewriting application logic.

**Each application keeps its own window and session.**

Home and tool windows can remain open together, preserving ADR-0209's separate
windows. Focusing another window does not close stores, release folder handles,
or cancel work. Native administration and tool execution retain distinct labels
and command grants. A page can continue using its admitted capabilities while
another application is focused; durable background work needs an explicit host
service rather than relying on a background WebView timer.

Before destroying or replacing a page, its lifecycle must resolve unsaved drafts
and confirm local persistence. Failure keeps the page available for recovery;
discarding unsaved work requires an explicit choice. Ending a folder session
does not cancel work its native owner already admitted or close another window's
session. Host shutdown drains admitted folder work and releases the locks.
Crashes and forced termination remain bounded by the most recent successful
durable write.

**Applications may reference several folders, and several applications may
write through the same folder owner.**

The host registers each canonical folder once under a shared scope and grants
that scope to the windows allowed to use it. An app can attach to several scopes
under `~/Epicenter`; folder identity is independent of the app displaying it.
Two apps referencing the same folder reuse its native owner through separate
sessions. They do not create competing owners or private copies of the files.
Different, non-overlapping folder roots have independent owners and locks.

The owner coordinates file mutations and Git operations and publishes changes
to attached windows. Apps can edit different files concurrently. When edits
target the same file, a replacement based on a read must name the source hash;
a stale save reports a conflict so the app can preserve and resolve its draft.
An explicit overwrite remains an intentional operation. Sharing an owner does
not merge simultaneous typing or make unrelated folder writes transactional.
A second native process attempting to own the same folder is refused by the
cross-process lock.

**Each product owns a stable local replica independently of the synchronized
dataset identity.**

Physical cache identity includes the installation's storage namespace, account
identity when applicable, and dataset identity. It remains stable across
launches. Outbox, cursor, and persistence claims belong to that replica. Separate
products do not open the same physical database merely because they synchronize
the same dataset. Concurrent synchronized tools need distinct persistent
replicas or an explicitly shared store owner; they cannot independently claim
the same physical database. A shared native folder owner addresses file-backed
concurrency and does not establish Yjs replica coordination.

Every active consumer of a synchronized dataset retains its live in-memory
replica. The inspector opens an authorized replica in its page using a compatible
data definition;
it does not read another product's private database or create a hidden native
document owner. This requires a definition-discovery and replica-opening path.
Cross-product changes converge through the account authority. Immediate offline
sharing between products is not promised, and a closed product's unsent changes
may wait until that product runs again. First opening a personal dataset may
require a connection. Synchronized preferences do not expose another product's
machine-local settings or credentials.

**Shortcut ownership follows the runtime that executes the action.**

Personal tools use focused-window shortcuts and yield reserved navigation
bindings to Epicenter. Standalone applications register their own global
shortcuts, release their registrations on shutdown, and surface registration
failures with a way to rebind. Distinct command names do not namespace keyboard
chords. Neither synchronized preferences nor Epicenter's settings UI arbitrates
live OS registrations. No application intentionally replaces another's bindings;
conflict detection and delivery must be verified on each supported platform.

**Installing a personal tool is an explicit choice to run trusted code.**

Examples may be downloaded or built from source and then installed as built SPA
artifacts. Building source is a separate intentional operation from opening the
artifact. The shared origin is not a sandbox. Native label separation preserves
command routing; it does not establish isolation from hostile deployed code.

## Consequences

Independent products can release native changes without an Epicenter release.
They also own signing, updates, credential setup, and native dependencies.
Shared Rust crates reduce implementation duplication without requiring a daemon.
The existing Hugging Face cache can share downloaded model files, but each
process owns its loaded model and active-model setting. Shared file deletion
needs an explicit administration policy. A shared inference service remains a
separate decision justified by measured resource or setup costs.

Native folder ownership removes the need for page-level owner election for
file-backed tools. Several tools can work on the same source files through that
owner while tools using other folders proceed independently. Synchronized
replicas still require their own persistence identities and delivery model.
Neither concurrent windows nor shared folders promises offline convergence
between independent Yjs replicas.

The initial implementation proof is two installed tools open beside Home. One
tool opens two folders; both tools attach to one shared folder. Edits to different
files must survive reopening, and competing saves to one file must report a
conflict without losing either draft. Closing one session must leave the other
usable. Injecting a storage failure must preserve the affected draft for recovery.
A standalone build must keep working after Epicenter quits; concurrent native
processes targeting the same folder must receive a busy refusal. Native work
and callbacks must remain associated with the session that admitted them.

The product proof is a repeated cross-app task that improves on manual
export/import. A candidate is a tool that reads Whispering transcripts and
writes derived notes into its own dataset. Reading without mutating the source
reduces integration risk; it is an implementation convention, not an enforced
permission boundary for trusted code.

Three contracts remain unresolved before that proof:

- The producer's supported read shape, compatibility policy, and behavior when
  producer and consumer versions differ.
- What a source reference identifies, including edits or deletion after notes
  are derived, and whether outputs are pinned, refreshed, or marked outdated.
- What freshness the consumer can report from its own received and persisted
  state. It cannot know whether an offline producer holds newer edits.

One known dataset and a maintained first-party consumer can test this without
general discovery. Measure repeated task completion and friction against the
existing workflow; comparing retention between self-selected one-app and
two-app users does not establish causation. Expand the tool runner when people
request additional tools and native packaging or distribution demonstrably
blocks their delivery. Successful integration alone does not establish demand
for a host or a public framework. Preserve the architectural options without
treating all deployment targets as simultaneous launch commitments.

## Considered alternatives

- **Every application lives in the Epicenter host.** Saves per-product packaging
  but couples native releases and failures and requires concurrent hosted
  lifecycle coordination.
- **One hosted personal tool at a time.** Avoids concurrent page-owned replicas
  by ending one session before opening another. Withdrawn: shared native folder
  owners coordinate file-backed tools without imposing that limit on windows.
- **Every personal tool is immediately a native product.** Requires native
  packaging before a small local experiment can be useful.
- **A mandatory shared daemon owns documents, shortcuts, and inference.** Adds
  discovery, version compatibility, and service lifecycle before those shared
  resources have demonstrated a need for one owner.
