# Vault pages migration: notes

Script: `migrate.ts` (`convertFrontMatter`, `slugRefusal`, `migrate`). Proof: `verify.ts`.
Nothing here was run on `~/Epicenter`; the script refuses that path without `--real`.

## Command

```
bun migrate.ts <pages-dir>            # report only
bun migrate.ts <pages-dir> --write    # move and convert
bun verify.ts <original-copy> <migrated-copy>
```

Proof ran on two temp copies of the `.md` files from `~/Epicenter/apps/vault/data/pages`
(3,394 files: 3,347 top-level, 47 inside 117 existing folders; second proof on a fresh copy after adding the list-item and blank-line rules): an untouched
original and a work copy. Dry run, `--write`, and a second `--write` (hash of all 3,394
files identical before and after).

## Rules added in the second pass

- A block-list item that is already JSON (`- {"to":"medium/braden"}`) stays that value.
- A block list of small maps (`- on: x` then `to: y` at the key column) becomes an array of objects, keys in order, values by the scalar rules. Deeper nesting is hand conversion.
- Blank lines inside the front matter are dropped.
- A wrapped multi-line plain scalar stays hand conversion; so do flow maps written as YAML (`- { on: "x", to: y }`).

## Counts

| Check | Count |
| --- | --- |
| top-level pages moved to `{slug}/page.md` | 3,347 of 3,347 |
| body bytes equal to original (sha256) | 3,347 |
| front matter converted (readable by `readMarkdown`, 0 `notJson` lines, key order kept) | 3,337 |
| second `--write`: files moved or changed | 0 (hash of all 3,394 files identical) |
| left for hand conversion (moved, bytes identical to original) | 10 |
| conflicts / refused slugs | 0 / 0 |
| existing nested `.md` files left unchanged | 47 of 47 |
| value differences against `Bun.YAML` on the original block | 0 |

## Hand conversion (10 files)

### flow map (7)

- `2026-08-11-what-is-liberalism`
- `2026-08-11-when-i-say-liberalism-i-dont-mean-the-left`
- `2026-08-22-the-right-people-are-not-enough-to-justify-concentrated-power`
- `2026-09-09-visualizing-the-cost-of-choosing`
- `2026-09-23-mandarin-is-public-in-singapore-and-private-in-america`
- `2026-10-06-hierarchy-is-something-to-manage-not-transcend`
- `2026-11-04-zoom-in-then-zoom-out`

### indented line (nested map or continuation) (3)

- `2022-06-16-how-is-enemies-to-lovers-possible`
- `2026-10-10-second-and-fourth-generation-chinese-american`
- `2026-10-12-the-downside-of-settling-into-a-routine`

