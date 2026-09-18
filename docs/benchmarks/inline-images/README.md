# Inline images versus URL references

Inline images remain excluded from the proposed product. This benchmark checks
the cost of the alternative; it does not implement it.

For 1,000 notes, embedding one synthetic 100 KiB image per note increased the
raw Yjs snapshot from 2.976 MB to 139.479 MB. A title edit still encoded to
58 to 59 bytes. The concern is the size of the synchronized document, not
resending existing images with each small edit.

## Run and evidence

From the repository root:

```sh
bun packages/app/evidence/data/bench/inline-images.ts
```

[Source](../../../packages/app/evidence/data/bench/inline-images.ts).
[Recorded results](2026-09-16-bun.json).

Recorded on 2026-09-16 with Bun 1.3.14, `@y/y` 14.0.0-rc.24, macOS arm64.
MB below means decimal megabytes. KiB means 1,024 bytes.

| Notes | Image representation | Raw V2 snapshot | Median update application |
| --- | --- | ---: | ---: |
| 100 | URL | 0.298 MB | 2.89 ms |
| 100 | Inline payload | 13.948 MB | 3.78 ms |
| 1,000 | URL | 2.976 MB | 6.10 ms |
| 1,000 | Inline payload | 139.479 MB | 14.91 ms |

Each row has a title, a 2,850-character body, and one image value. The inline
case uses unique random bytes encoded as a base64 data URL; these are synthetic
payloads, not valid WebP files. Each 100 KiB payload becomes 136,536 base64
characters before its prefix. This expected payload growth explains most of
the difference; it is not evidence of unusual CRDT overhead.

Each case has one builder process and three fresh reader processes. Snapshot
input bytes are loaded before timing `applyUpdateV2`. Snapshot encoding has
one sample per case. This is a comparison, not a performance threshold.

Controls verify the row count, a complete image value and body, and a title
delta applied to a second replica while preserving the edited row's image.
After removing all image attributes, another fresh replica must retain every
body and the edited title while containing no image attributes. An empty
document must fail the expected corpus count.

## What the measurements establish

- For this corpus, embedding images makes the synchronized document about
  46.9 times larger. The URL case excludes hosted image storage and later
  downloads, so this is not a comparison of total storage or total bandwidth.
- Title updates remain small in both cases. Across all recorded cases they
  were 57 to 59 bytes; random client identifiers account for small differences.
- With `gc: true` and no undo manager retaining deleted content, removing all
  images reduced a newly encoded 1,000-row snapshot to about 2.920 MB in both
  cases. This does not establish reclamation of existing update logs, backups,
  or process memory.
- Update application timing excludes image decoding, editor rendering,
  database writes, projections, network transfer, and transport compression.
  It is not application startup latency. The synthetic schema uses a value
  field, not the actual editor's image-node representation.

RSS differences in the JSON are diagnostic only; they include runtime
allocation effects. No heap-size conclusion is drawn.

An independent Astra review checked the method and suggested the edited-row
and post-deletion controls. Both were added and all cases reran successfully.
The result supports retaining the decision to keep image bytes outside the
synchronized document; it does not establish that embedding is unusable for
every small corpus.
