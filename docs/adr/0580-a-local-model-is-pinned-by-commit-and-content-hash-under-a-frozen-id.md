# 0580. A local model is pinned by commit and content hash under a frozen id

- **Status:** Superseded
- **Date:** 2026-10-16
- **Superseded by:** [ADR-0618](0618-epicenter-hosts-no-ai-service.md), Epicenter's inference: Epicenter runs no inference or transcription gateway, bills no AI credits, and keeps no AI connection or local model.
- **Relates:** [ADR-0579](0579-epicenter-never-deletes-a-model-from-the-shared-hugging-face-cache.md) (the shared cache these files live in), [ADR-0397](0397-native-inference-selects-an-installed-model-explicitly.md) (requests and transcripts name the model id).

## Context

Each entry in `CATALOG` (`apps/epicenter/src-tauri/src/transcription/catalog.rs`)
downloaded `revision: "main"`, found its file through `hf-hub`'s
`Cache::repo(..).get()`, which reads `refs/main`, and rendered its id as
`"{repo_id}@{revision}/{filename}"`. A tool that moved `refs/main`, or fetched
the same file at another commit, made Epicenter's model read as not
downloaded. On the machine this was written on, `whisper-tiny-Q8_0.gguf` sat at
commit `6687f30c…` while `main` was `1bd61cda…`, with identical bytes.

## Decision

**Each catalog entry pins a commit and its file's SHA-256, and presence is
decided by the cache's content address.** `download_model` fetches the
pinned commit. A model is present when `snapshots/<commit>/<filename>`
exists for its pinned commit, or when any `snapshots/*/<filename>` resolves
to `blobs/<sha256>`, the name `hf-hub` gives a file by its hash. Epicenter
trusts that layout and does not hash a model file itself; a file corrupted
in place is repaired by deleting its folder and downloading it again:

```txt
CatalogEntry
  id       "handy-computer/whisper-tiny-gguf@main/whisper-tiny-Q8_0.gguf"   frozen
  coord    repo_id  "handy-computer/whisper-tiny-gguf"
           commit   "1bd61cda36bbd22c88fc5a33842498a6e1d30f45"              downloads fetch this
           filename "whisper-tiny-Q8_0.gguf"
           sha256   "325b9c79…"                                              presence checks this
```

**A model id is a frozen string, not a rendering of the coordinate.** The
active choice in `local-transcription.json` and the model named on each
transcript keep the shipped ids, `@main` included.
`shipped_model_ids_never_change` pins them.

## Consequences

- Moving a model to a newer commit is a catalog edit that changes `commit` and
  `sha256` and keeps `id`. Until then, a file with other bytes is not the
  model, and an install holding an older quantization reads as not downloaded.
- The match at another commit needs a symlinked cache. Where `hf-hub` cannot
  symlink (Windows without the privilege), it moves the blob into the
  snapshot, and only the pinned commit's file counts.
- Presence costs one directory read of the repo's `snapshots/` when the pinned
  snapshot is absent.

## Considered alternatives

- **Pin only the commit and look up `snapshots/<commit>/`.** Files fetched at
  an earlier commit with identical bytes, as on existing installs, read as
  missing.
- **Render the id from the pinned commit.** Every stored choice and transcript
  id would stop resolving.
- **Match by file size.** Re-quantized files can keep their size.
