# 0449. Epicenter connects independent applications through personal data

- **Status:** Proposed
- **Date:** 2026-09-28
- **Amends:** [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) at mandatory shared desktop packaging; [ADR-0209](0209-epicenter-is-the-raw-view-beside-its-applications-not-a-shell-above-them.md) at separate windows for hosted personal tools; [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) at the refusal of standalone desktop products; [ADR-0180](0180-epicenter-has-one-host-owned-active-local-transcription-model.md) at machine-wide engine ownership; [ADR-0323](0323-background-work-runs-in-the-host-and-a-window-is-for-looking-at.md) at Epicenter hosting other products' background work.
- **Relates:** [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) preserves client-owned replicas and authority synchronization; [ADR-0334](0334-a-deployed-app-is-a-trusted-app-because-deploying-it-was-the-consent.md) preserves explicit deployment as trust in the code.
- **Unbuilt:** standalone product packaging, personal-tool installation and switching, a verified local save barrier, replica addressing for concurrent products, and the synchronized-data inspector described below.

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
`src/applications.ts` declares a fixed application list. Product windows share
native capabilities. Arbitrary personal-tool installation and standalone
packaging are not established by the README's obsolete `catalog:publish`
instructions.

The shared native core reduces distribution work, but couples product releases
and native failures. A useful personal tool need not become a native product
before someone can use it. A focused product need not remain inside Epicenter
to participate in the same data ecosystem.

## Decision

**Focused products run independently; Epicenter desktop manages shared personal
data and runs one personal tool at a time.**

| Product | Execution and ownership |
| --- | --- |
| Standalone applications, including Whispering | Own installation, native runtime, updates, credentials, persistent replicas, and any background work. They can run concurrently and do not require Epicenter desktop to remain open. |
| Epicenter desktop | Browses authorized synchronized datasets, manages synchronized preferences and its own device settings, and runs one personal tool session. |
| Personal tool | An explicitly installed, trusted SPA that runs while selected in Epicenter. It has no hidden page, persistent global shortcuts, or background execution after leaving it. |
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
library whose files are canonical. In the latter, edits to files are edits to
the data, and a SQLite index can be rebuilt from those files. This record does
not require permanently local data to use Yjs or Markdown. It does not promise
that file libraries, local databases, and synchronized replicas expose identical
editing capabilities or can be converted by changing an opening function.

Browsing data and working through files are useful workflows to test separately
from demand for hosted applications. A person can customize their workflow with
an editor, script, or agent before building an SPA. The personal-tool runner
extends this workspace; it is not its sole reason to exist.

A tool needing residency or additional native capabilities can become a
standalone application. Browser, hosted, and standalone builds may share source
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

Changing packaging preserves the logical dataset identity. The standalone
application opens its own persistent replica of that dataset. Unsynchronized
hosted edits require either synchronization before transfer or an explicit local
export/import path; a packaging command does not move the data. The first proof
must run one SPA both hosted and standalone without rewriting application logic.

**A personal-tool switch ends the previous session before opening the next.**

Epicenter's data/settings page and its tool page alternate. Native administration
and tool execution retain distinct labels and command grants; only one page is
alive. The inactive page is destroyed, not retained as a hidden replica. A
stateless native navigation control can survive both.

A controlled switch stops admitting edits and new operations, settles or
cancels native work, confirms local persistence, closes the old stores, and
releases their claims before opening the next page. Confirmation includes native
artifacts and their document references where relevant. It does not wait for
remote synchronization. Failure keeps the old session available for recovery;
discarding unsaved work requires an explicit choice. Full navigation supplies
the page boundary, not the durability guarantee. Native operations and late
callbacks need their own acknowledged termination before handoff.

Current `packages/app/src/data/store/store.ts` attempts a flush during close and
then destroys the document. That is not the save barrier promised here.
Crashes and forced termination remain bounded by the most recent successful
durable write.

**Each product owns a stable local replica independently of the synchronized
dataset identity.**

Physical cache identity includes the installation's storage namespace, account
identity when applicable, and dataset identity. It remains stable across
launches. Outbox, cursor, and persistence claims belong to that replica. Separate
products do not open the same physical database merely because they synchronize
the same dataset. Sequential tools inside Epicenter can reopen its local copy;
two consumers in one session reuse an opened handle rather than competing for
the same claim.

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

One active personal-tool session removes the need for simultaneous hosted
replicas, local peer delivery, owner election, and tool background scheduling.
It does not solve synchronization between standalone apps or browser origins.
Recording or long-running work must finish or cancel before a tool switch;
applications that must keep working belong in a standalone runtime.

The initial implementation proof is one installed tool that edits offline,
switches to inspection, and reopens with its edits intact. Injecting a storage
failure must refuse the switch without destroying the old session. A standalone
build must keep working after Epicenter quits and converge through the same
authority when connected. Native work must not deliver into the next tool.

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
- **Only one application can run anywhere.** Removes useful standalone
  concurrency to solve a problem confined to the personal-tool environment.
- **Every personal tool is immediately a native product.** Requires native
  packaging before a small local experiment can be useful.
- **A mandatory shared daemon owns documents, shortcuts, and inference.** Adds
  discovery, version compatibility, and service lifecycle before those shared
  resources have demonstrated a need for one owner.
