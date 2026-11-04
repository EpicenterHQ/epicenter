# 0758. Epicenter adapts to what you already have and owns only what nothing else can

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Relates:** [ADR-0741](0741-epicenter-reconciles-only-states-it-made.md) (the inward rule: Epicenter reconciles only states it made), [ADR-0749](0749-epicenter-draws-its-boundaries-where-people-already-expect-them.md) (boundaries where people already expect them), [ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md) (your own `git` is plain Git), [ADR-0757](0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md) (models and model files), [ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) (its inward form: Epicenter is made of standards and places).
- **Unbuilt:** the adaptations ADR-0757 names (any endpoint, the Hugging Face cache as every app's model store); `settle` in the Rust sync core ([ADR-0751](0751-every-native-app-carries-one-sync-core.md)).

## Context

Records made on 2026-11-04 kept choosing a thing the person already has over
one Epicenter would make.
[ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md) left a
person's own `git` as plain Git.
[ADR-0752](0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md)
put items in folders a person sees in Finder or the Files app.
[ADR-0731](0731-every-app-signs-in-as-its-site.md) signs each app in through
standard OAuth. [ADR-0757](0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md)
takes any model as an endpoint and keeps model files in the Hugging Face
cache other tools share, as `catalog.rs` in
`packages/tauri-plugin-epicenter-transcription` already does.

[ADR-0741](0741-epicenter-reconciles-only-states-it-made.md) states the rule
for states inside a folder: Epicenter repairs what it made and refuses the
rest with a command. No record states the matching rule for what Epicenter
builds at all, so each design argued it again.

## Decision

**Epicenter owns what no tool a person already has does: syncing an app's
folder, and the merge rule. For everything else it adapts to the tool the
person has, in that tool's own format and place.**

| | What Epicenter does | Record |
| --- | --- | --- |
| Owns: syncing folders | the sync core's round: commit, fetch, merge, Git LFS, push, at the moments a person expects | [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md), [ADR-0751](0751-every-native-app-carries-one-sync-core.md) |
| Owns: the merge rule | `settle`: fields by key, the body by line; every other file kept whole | [ADR-0734](0734-every-file-other-than-a-note-is-kept-whole-in-git-lfs.md) |
| Adapts: models | any endpoint: hosted, a provider key, Ollama, LM Studio, in-process speech | [ADR-0757](0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md) |
| Adapts: model files | the shared Hugging Face cache | [ADR-0757](0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md) |
| Adapts: history | plain Git, which stock `git` reads and writes | [ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md), [ADR-0747](0747-git-runs-only-as-git-on-the-desktop.md) |
| Adapts: other hosts | your own remotes; a folder that tracks another host syncs only with it | [ADR-0741](0741-epicenter-reconciles-only-states-it-made.md) |
| Adapts: sign-in | standard OAuth, one grant per app | [ADR-0731](0731-every-app-signs-in-as-its-site.md), [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) |
| Adapts: files | folders you can see, under the platform's visible root | [ADR-0752](0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md) |

**A design that adds a format, store, registry, or protocol of Epicenter's
own names the tool a person already has that it replaces, and why that tool
cannot serve.**

## Consequences

- What Epicenter writes, a person's other tools read: `git log` shows the
  history, a Hugging Face tool sees the models, Finder shows the files, and
  an OAuth client library signs in.
- Epicenter inherits each tool's limits. A person's own `git pull` merges a
  note by line (ADR-0733), a model file is deleted with Hugging Face's
  tools, and a server on another host syncs on that host's terms.
- A person who leaves Epicenter keeps a Git repository, a folder of
  Markdown, and a model cache, each usable without it.
- The code Epicenter maintains concentrates in the sync core and `settle`.
  A feature outside those two starts from the tool it adapts.

## Considered alternatives

- **Own each layer: a model store, a history format, a host of Epicenter's
  own.** A person's data then needs Epicenter to read, and every layer is
  code Epicenter keeps beside a tool that already works.
- **Adapt sync too, to a file-sync service or a person's own `git pull`.**
  No such tool merges an item's fields by key, and a file-sync service
  keeps no history a person can read.
- **Decide per design with no rule (today).** Each record argued the same
  question, and nothing marks a design that owns a layer without saying
  why.
