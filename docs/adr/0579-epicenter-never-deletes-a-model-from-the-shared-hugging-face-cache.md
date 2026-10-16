# 0579. Epicenter never deletes a model from the shared Hugging Face cache

- **Status:** Proposed
- **Date:** 2026-10-16
- **Amends:** [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) at `models/<provider>/<model-id>/` in app data and "A person deletes them in Settings": models stay in the shared Hugging Face cache, and Settings shows a model's folder instead of deleting it.

## Context

ADR-0539 placed downloaded models under `models/<provider>/<model-id>/` in app
data, and said a person deletes them in Settings. Neither was built. Models
download through `hf-hub` into the shared Hugging Face cache
(`~/.cache/huggingface/hub`, or `HF_HOME`), and Settings offered **Delete**,
which called `delete_model` to unlink the snapshot pointer and its blob.

Other tools read and write that cache. A file Epicenter deleted may be one
another tool fetched or still uses, and the cache already has owners for
cleanup (`hf cache delete`). Each catalog entry also downloaded `revision:
"main"` and found its file through `refs/main`, so a tool that moved
`refs/main`, or fetched the same file at another commit, made Epicenter's model
read as not downloaded.

## Decision

**Epicenter downloads models into the shared Hugging Face cache and never
deletes from it.** It reaches:

- `apps/epicenter/src-tauri/src/transcription/catalog.rs`: `download_model`
  writes through `hf-hub`; there is no `delete_model`. `reveal_model` shows a
  downloaded model's repo folder, `models--<org>--<repo>`, in the system file
  manager. The folder, because the file is a symlink and the file manager would
  select the hash-named blob it points to.
- `apps/epicenter/src/ui/LocalModelAdministration.svelte`: each downloaded
  model offers **Show folder**, not **Delete**, and the card says
  "Epicenter never deletes them; to free space, show a model's folder and
  delete it."

**Each catalog entry pins a commit and its file's SHA-256, and presence is
decided by the bytes.** A model is present when `snapshots/<commit>/<filename>`
exists for its pinned commit, or when any `snapshots/*/<filename>` resolves to
`blobs/<sha256>`:

```txt
CatalogEntry
  id       "handy-computer/whisper-tiny-gguf@main/whisper-tiny-Q8_0.gguf"   frozen
  coord    repo_id  "handy-computer/whisper-tiny-gguf"
           commit   "1bd61cda36bbd22c88fc5a33842498a6e1d30f45"              downloads fetch this
           filename "whisper-tiny-Q8_0.gguf"
           sha256   "325b9c79…"                                              presence checks this
```

**A model id is a frozen string, not a rendering of the coordinate.** The
stored active choice in `local-transcription.json` and the model named on each
transcript keep the shipped ids, `@main` included.

## Consequences

- A file removed outside Epicenter reads as not downloaded the next time the
  catalog resolves it, and an active model without its file shows "is active
  but not downloaded" in Settings. Epicenter no longer clears the active choice
  for a missing file; the person downloads it again or picks another model.
- Freeing disk is a step outside Epicenter.
- Moving a model to a newer commit is a catalog edit that changes `commit` and
  `sha256` and keeps `id`. A file at a commit with other bytes is a different
  model until then.
- The match at another commit needs a symlinked cache. Where `hf-hub` cannot
  symlink (Windows without the privilege), it moves the blob into the
  snapshot, and only the pinned commit's file counts.
- Presence costs one directory read of the repo's `snapshots/` when the pinned
  snapshot is absent.

## Considered alternatives

- **Models under `models/<provider>/<model-id>/` in app data.** Duplicates
  files the shared cache already holds and that other tools reuse.
- **Pin only the commit and look up `snapshots/<commit>/`.** Files fetched at
  an earlier commit with identical bytes, as on existing installs, read as
  missing.
- **Render the id from the pinned commit.** Every stored choice and transcript
  id would stop resolving.
