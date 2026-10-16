# 0579. Epicenter never deletes a model from the shared Hugging Face cache

- **Status:** Proposed
- **Date:** 2026-10-16
- **Amends:** [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) at `models/<provider>/<model-id>/` in app data and "A person deletes them in Settings"; [ADR-0180](0180-epicenter-has-one-host-owned-active-local-transcription-model.md) at "deleting" in Home's model administration. Models stay in the shared Hugging Face cache, and Settings shows a model's folder instead of deleting it.

## Context

ADR-0539 placed downloaded models under `models/<provider>/<model-id>/` in app
data and said a person deletes them in Settings, and ADR-0180 listed deleting
among Home's model administration. Models never moved to app data: they
download through `hf-hub` into the shared Hugging Face cache
(`~/.cache/huggingface/hub`, or `$HF_HOME/hub`). Settings offered **Delete**,
which called `delete_model` to unlink the model's snapshot pointer and its
blob.

Other tools read and write that cache. A file Epicenter deleted may be one
another tool fetched or still uses, and the cache already has its own cleanup
commands (`hf cache rm`).

## Decision

**Epicenter downloads models into the shared Hugging Face cache and never
deletes from it.** It reaches:

- `apps/epicenter/src-tauri/src/transcription/catalog.rs`: `download_model`
  writes through `hf-hub`; there is no `delete_model`. `reveal_model` shows a
  downloaded model's repo folder, `models--<org>--<repo>`, in the system file
  manager. It shows the folder because the file is a symlink into `blobs/`,
  which the file manager resolves to a hash-named blob.
- `apps/epicenter/src/ui/LocalModelAdministration.svelte`: each downloaded
  model offers **Show folder**, not **Delete**, and the card says
  "Epicenter never deletes them; to free space, show a model's folder and
  delete it."

## Consequences

- Freeing disk is a step outside Epicenter: deleting the folder, or
  `hf cache rm`.
- A model removed outside Epicenter reads as not downloaded the next time the
  catalog resolves it. If it was the active model, Settings shows "is active
  but not downloaded" until the person downloads it again or picks another
  model. Delete no longer clears the active choice, because there is no Delete.
- Deleting the repo folder also removes other files in that repo that other
  tools fetched.

## Considered alternatives

- **Models under `models/<provider>/<model-id>/` in app data.** Duplicates
  files the shared cache already holds and that other tools reuse.
- **Delete only the blob and pointer Epicenter downloaded.** Epicenter cannot
  tell whether another tool also uses that file.
