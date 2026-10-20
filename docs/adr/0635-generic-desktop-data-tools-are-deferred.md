# 0635. The Epicenter desktop app is deferred

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amends:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) at treating the desktop data browser and minimal runner as current delivery scope, and [ADR-0627](0627-every-change-to-the-data-model-is-checked-against-nine-principles.md) at the desktop browser and runner in principle 9.
- **Relates:** [ADR-0632](0632-a-lens-belongs-to-its-reader.md) (reader-selected schemas), [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) (independent local apps), and [ADR-0634](0634-hosted-inference-is-independent-of-repository-sync.md) (optional hosted inference).
- **Amended by:** [ADR-0648](0648-a-folders-saved-views-live-in-its-optional-epicenter-json.md) at generic structured desktop tools, now delivered as grid and read-only SQL over an open Folder.
- **Unbuilt:** an arbitrary personal-tool runner, saved-view persistence, and board presentation. Shared disk access, Files, grid, read-only SQL, and the desktop host for the fixed bundled apps are implemented; see the [desktop README](../../apps/epicenter/README.md). These optional clients still do not gate standalone or browser apps.

## Context

ADR-0611 retained a small runner in `apps/epicenter` for built personal
websites over chosen disk repositories. Its window creation and serving
code remain implementation material. The local-first app opening API and
standalone Whispering are still unfinished.

The chosen first delivery is useful apps over local files, with optional
Git synchronization and inference. The Epicenter desktop app and its personal
app runner can follow without becoming dependencies of that delivery.

## Decision

**The Epicenter desktop app and its runner are later, optional clients.**
Epicenter desktop app is the product name. Host app and desktop host describe
its possible runtime role, not a separate product. Runner names its capability
to open built local interfaces; launcher is an ordinary description of opening
an app. None introduces another required component.

Do not make their migration, window model, or app-opening workflow a gate
for the local data toolkit, standalone apps, browser apps, CLI, or hosted
services. Deferral does not restore the older full app platform.

**The Epicenter desktop app can add structured views through a selected schema file.**
A person can open ordinary data folders. The later app can use the same root
epicenter.json as the CLI; its selection interface remains deferred. Without a schema file, files remain browsable. The
filename grants no permissions and creates no requirement for apps to
write metadata. Schema-file selection and editing follow ADR-0632; the app's
interface and packaging can be designed when that client is built.

**A later runner may open built personal interfaces over selected folders.**
The interface's files and the data folder have independent locations and
lifetimes. It reuses data access and synchronization rather than creating
a private copy of each tool's records. Native recording, local models,
shortcuts, and specialized permissions remain concerns of standalone apps.
Source acquisition, dependency installation, builds, approval workflows,
catalogs, and a general native API remain outside the minimal runner.

## Consequences

- The data toolkit and optional services can be proven in Whispering and
  browser apps without first shipping a replacement Epicenter desktop shell.
- Existing runner and file-serving code can be evaluated for reuse later;
  retaining it is not a commitment to its present grants or installer.
- Generic inspection still benefits from the schema-file contract. No runner
  must exist for the CLI to read ordinary files or select a schema file.
- A future runner must verify coordinated saves when it shares a disk
  folder with a standalone app. That work belongs to its implementation.

## Considered alternatives

- **Ship the minimal runner alongside the first data API.** Adds window,
  file-serving, and concurrent disk-client work before independent apps
  establish the shared contract.
- **Delete the runner direction permanently.** Removes a useful later way
  to use agent-built personal tools without packaging each separately.
