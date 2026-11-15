# Result: editable Tasks runs on Workers

Question: can the existing Tasks Svelte UI and action source be edited, compiled,
and executed without a container, preserving the working version on a failed
build?

Answer: yes, within a fixed Worker-compatible build pipeline. The hosted proof
passed 19 checks and the browser proof passed seven. Source was uploaded raw;
the uploader did no application compilation. Svelte renders in the browser;
its compilation and the action runtime run in Workers.

## Evidence from the scratch deployment

Test date: November 14, 2026, Pacific time (November 15 UTC).

- Worker: `epicenter-tasks-workers-prototype` under Epicenter's account.
- Hosted API/build evidence: `proof-cloudflare.json`.
- Browser evidence: `evidence/browser-proof.json` and its screenshots.
- Build V1: 24,642 ms; build V2: 29,297 ms, compiling 287 Svelte components.
- While V2 compiled, the V1 page and list action both succeeded in a combined
  164 ms. This is one observation, not a latency benchmark.
- The action edit changed `add` to prefix titles with `Cloud: `.
- The UI edit changed the visible heading to `Tasks in Workers`.
- Deliberately invalid Svelte and TypeScript returned 422; V2 remained active.
- The published JavaScript stayed byte-identical after failure. An unpublished
  icon edit also left the published icon unchanged.
- Actual Tasks add, set, note, get, list, and delete actions worked with Markdown
  text persisted in the Durable Object's SQLite storage.
- A stale V1 caller received 409 after V2 published.
- Chromium rendered the hosted UI on desktop and mobile without JavaScript
  errors or failed asset/API responses. A task created through the UI retained
  its completion after reload. The browser proof deleted that synthetic task.
- The platform host and verification scripts passed TypeScript checking.

The scratch data contains synthetic records from repeated probes. Neither the
person's Tasks data nor its running Studio instance was used.

## The important failure

The initial implementation compiled inside the app's Durable Object. One hosted
build succeeded; the second reset its isolate. Cloudflare tail logs explicitly
reported: `Durable Object's isolate exceeded its memory limit and was reset.`
Local workerd had passed repeated builds, so the production run was necessary.

The final implementation uses `LOADER.load()` to create a fresh compiler Worker
for each build. A small manifest and source files needed synchronously are
passed initially; other dependency modules are read through a read-only RPC
capability. The app Durable Object owns storage and publishing and continues
serving its published revision while the compiler runs. The repeated hosted
build and failure tests passed after this change.

## What collapsed, and what remains

For a person: edit files, build, use the app. The product does not require a
machine type, SSH setup, shell, process manager, or deployment project per app.

For the platform: source, durable app data, a transient compiler, and a published
revision are distinct lifetimes. A successful revision contains its UI, action
bundle, and static assets. The active pointer selects the whole revision. Keeping
these lifetimes separate prevented compiler failure from owning app availability.
Combining the compiler with the durable data owner was simpler in code but failed
the memory and availability requirements.

This supports a narrower promise than a Linux server. Dependencies must work in
the browser or Workers; arbitrary npm install scripts, binaries, and operating
system packages are outside the contract. The fixed platform compiler can be
changed centrally without asking a person to maintain their own toolchain.

## Review scope and limits

Reviewed the raw source upload path, dependency resolver, compiler boundary,
action adapter, SQLite file operations, revision publishing, auth gate, and
browser caller. Review fixed a source-upload/build race and made static assets
part of a published revision. No unresolved defect was found in the tested happy
path and compile-failure path.

This is a single-app feasibility prototype, not an audited multi-tenant service.
The README lists what remains unimplemented. In particular, yields are discarded
by the current adapter; this does not prove streaming or durable resumable runs.
The copied app runtime needed lazy AbortController initialization and a YAML shim.
The compiler uses an experimental Cloudflare package and its unstable custom
plugin API. This is sufficient evidence for feasibility, not a claim that the
current build code is ready for production.

Local rechecks interrupted by Wrangler hot reloads were discarded. Use the final
`proof-local.json` for the completed local scenario. The hosted checks ran
against an unchanged deployment.
