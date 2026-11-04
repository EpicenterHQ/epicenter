# 0762. Epicenter is made of standards and places

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Relates:** [ADR-0758](0758-epicenter-adapts-to-what-you-already-have-and-owns-only-what-nothing-else-can.md) (its outward form: Epicenter adapts to what you already have), [ADR-0753](0753-an-app-declares-what-it-is-and-what-it-needs-the-platform-supplies-where-how-and-when.md) (an app declares what it is and what it needs), [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) (programs meet in the folder), [ADR-0757](0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md) (programs meet in the model cache; an endpoint is a Fetch API function).
- **Unbuilt:** the standards and places ADR-0757 adopts (`endpoint.fetch`, the Hugging Face cache as every app's model store) and `settle` in the Rust sync core ([ADR-0751](0751-every-native-app-carries-one-sync-core.md)).

## Context

[ADR-0758](0758-epicenter-adapts-to-what-you-already-have-and-owns-only-what-nothing-else-can.md)
states what Epicenter owns from the person's side: syncing folders and the
merge rule, and nothing a tool they already have does. It does not say what
Epicenter's own parts are made of, or how they reach each other.

The 2026-11-04 records answered both questions the same way each time. An
endpoint became a Fetch API function speaking the OpenAI-compatible
vocabulary ([ADR-0757](0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md)).
Sync stopped being a role one program plays for the others and became an
operation any program runs on a folder, meeting the others only in its lock
and its `.git`
([ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md)).
Apps share model files through the Hugging Face cache instead of a model
server (ADR-0757).

## Decision

**Epicenter's interfaces are standards someone else maintains, and its
programs meet only in shared places, never by calling each other.**

| Interface | Standard |
| --- | --- |
| history | Git |
| requests to a model | the Fetch API and the OpenAI-compatible vocabulary |
| sign-in | OAuth |
| an item | Markdown with front matter |
| a field | JSON Schema |
| model files | the Hugging Face cache |
| where data lives | folders |

| Shared place | Who meets there | Record |
| --- | --- | --- |
| an app's folder: its files, `.git`, and `.git/epicenter-sync.lock` | every program that syncs it | [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) |
| the Hugging Face cache | every app and tool that runs a local model | [ADR-0757](0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md) |

**Epicenter invents only what no standard covers:** the names derived from
an app's site
([ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md)), the merge
rule `settle`
([ADR-0734](0734-every-file-other-than-a-note-is-kept-whole-in-git-lfs.md)),
and the sync core
([ADR-0751](0751-every-native-app-carries-one-sync-core.md)).

**A new design answers two questions: which standard, and which shared
place?** A design that adds an interface of Epicenter's own names the
standard that could not serve. A design in which one Epicenter program
calls another names the shared place that could not serve.

## Consequences

- A tool that speaks the standard works with Epicenter unchanged: stock
  `git`, any OAuth client, any OpenAI-compatible client, any Markdown
  editor, a Hugging Face downloader.
- No Epicenter program needs another to be running. A program that finds
  the place busy waits, as a held round lock returns Retry.
- Epicenter carries each standard's limits: the OpenAI vocabulary has no
  word for downloading a model, so a local lifecycle needs a handle
  (ADR-0757), and Git has no merge that knows an item's fields, so
  `settle` exists.
- A feature that needs a live answer from another program, such as a
  synchronous action, has no channel until a design names why a place
  cannot serve.

## Considered alternatives

- **Epicenter's own interfaces where a standard is awkward.** Each one is a
  format only Epicenter reads and code only Epicenter maintains.
- **Programs that call each other: a daemon, a local socket, a model
  server.** One program must run for another to work, and the caller must
  find it, as "Syncing needs Epicenter" required before ADR-0750.

## Open, not decided

Whether the agent loop speaks the OpenAI vocabulary directly instead of its
own message types (`packages/ai/src/agent/engine.ts`, the loop of
[ADR-0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md)),
which `packages/ai/src/openai/agent-engine.ts` (280 lines) translates
today. It waits on a measurement of that translation code.
