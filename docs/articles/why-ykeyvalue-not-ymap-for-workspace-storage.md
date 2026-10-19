# Why the Workspace API Uses YKeyValue, Not Y.Map

> Historical: this article describes the retired YKeyValue-backed workspace
> table implementation. Current local rows are Markdown file views through
> [`@epicenter/folder`](../../packages/folder/README.md).

The Static Workspace API stores every table row through YKeyValueLww, a key-value store built on Y.Array. Not Y.Map. This is the obvious question: Y.Map is Yjs's native key-value type. Why build a custom one on top of Y.Array?

Because Y.Map was designed for collaborative editing, not database storage. And the difference shows up exactly where production workloads spend most of their time: saving the same row over and over.

## The Autosave Problem

Here's what a typical Epicenter session looks like. A user has five notes. They're actively editing one. Autosave fires every two seconds. Over a ten-minute editing session, that's 300 saves to the same row. The other four rows sit idle.

We benchmarked three approaches storing the same data: five rows with 20KB of text content each.

```
                  Baseline     After 300 saves     Growth
YKV:              98.44 KB     98.47 KB            +37 bytes
Y.Map Replace:    98.65 KB     101.88 KB           +3.23 KB
Y.Map Field:      98.65 KB     117.03 KB           +18.38 KB
```

YKV grew by 37 bytes. Y.Map field update (the "good" pattern everyone recommends: reuse the nested Y.Map, update individual fields) grew by 18 KB.

Scale that to an all-day session. Three documents actively edited over eight hours, 2,000 saves total:

```
YKV:           147.29 KB
Y.Map Field:   270.42 KB   (+83.6% bloat)
```

Y.Map is almost double the size. And this is one day. For a user who works in the same workspace for weeks, that gap keeps widening.

## Why This Happens

The difference comes down to what Yjs garbage collection can merge.

YKeyValueLww stores each row as a single entry in a Y.Array: `{ key, val, ts }`. The entire row is one opaque blob (Yjs calls this `ContentAny`). When you update a row, the old entry is deleted from the array and a new one is pushed. GC sees a sequence of deleted items in the array and merges them into a single compact `GC` struct. After 300 saves to the same row, all 299 deleted items collapse into a few bytes.

```
Y.Array after 300 saves to the same key:

Before GC:  [deleted][deleted]...[deleted][current]  (299 tombstones + 1 live)
After GC:   [gc_struct: length=299][current]          (a few bytes + 1 live)
```

Y.Map works differently. Each key in a Y.Map has its own internal linked list of Items. When you set a key, the new Item is appended to that key's list and the old one is marked deleted. These per-key tombstones can't merge across different keys because they live in separate lists.

With the "field update" pattern (reusing a nested Y.Map, calling `set()` on individual fields), each of the seven fields in the row accumulates its own tombstone chain. 7 fields × 300 updates × ~9 bytes per tombstone = 18 KB of unmergeable overhead.

```
Nested Y.Map after 300 field updates:

title:     [deleted][deleted]...[deleted][current]  (can't merge with ↓)
content:   [deleted][deleted]...[deleted][current]  (can't merge with ↑ or ↓)
summary:   [deleted][deleted]...[deleted][current]  (separate chain)
tags:      ...
createdAt: ...
updatedAt: ...
```

Each field's chain is independent. GC can merge within a chain but not across fields.

## The Counterintuitive Part

The Yjs community generally recommends: "Don't replace nested Y.Maps. Reuse them and update fields in place." This is good advice for collaborative editing, where you want field-level conflict resolution. Two users editing different fields of the same record should both succeed.

For database storage, it's the worst pattern. Every field update creates an unmergeable tombstone. The "dumb" approach of treating rows as opaque blobs and replacing the whole thing turns out to be optimal, because it gives GC something it can actually compact.

## The Full Picture

This isn't a universal win. YKV's advantage depends on garbage collection being enabled (`gc: true`, which is Yjs's default). With GC off (needed for version snapshots), YKV's tombstones can't merge either, and Y.Map actually wins. See the [decision guide](./ykeyvalue-vs-ymap-decision-guide.md) for that breakdown.

And there was a real trade-off: YKV used row-level last-write-wins. If two users edited different fields of the same row simultaneously, one person's change was lost. Y.Map would merge them. That retired implementation accepted the loss because most workspace data had a single author at a time and coherent whole-row schema evolution mattered more than concurrent field merging.

## When It Matters Most

The savings are proportional to how often you write to the same rows. Here's the scaling:

```
5 rows × 10K chars, measured after N update rounds:

Updates │ YKV          │ Y.Map Replace │ Y.Map Field  │
────────┼──────────────┼───────────────┼──────────────┤
      1 │ 49.62 KB     │ 49.88 KB      │ 50.11 KB     │
      5 │ 49.62 KB     │ 50.11 KB      │ 51.25 KB     │
     10 │ 49.63 KB     │ 50.39 KB      │ 52.80 KB     │
     25 │ 49.63 KB     │ 51.20 KB      │ 57.42 KB     │
     50 │ 49.63 KB     │ 52.54 KB      │ 65.11 KB     │
```

YKV stays flat. The others grow linearly with update count.

For write-once data (insert it, never touch it again), Y.Map is actually 1.6x more compact because it doesn't carry the `{ key, val, ts }` wrapper. But workspace data isn't write-once. Users edit their notes, update their settings, change their task statuses. The repeated-write pattern is the common case, and that's where YKV pays off.

## The Bottom Line

We chose YKeyValueLww as the storage primitive because workspace data gets saved over and over. Autosave, manual save, status changes, timestamp updates: these are all repeated writes to the same rows. YKV turns those into mergeable tombstones that GC compacts to near-zero. Y.Map turns them into per-field tombstone chains that grow forever.

The result: a workspace that's been used for months takes roughly the same storage as the data currently in it. History doesn't accumulate. That's the property we wanted, and YKeyValueLww is how we get it.

---

**Related:**

- [YKeyValue: A Space-Efficient Key-Value Store](./ykeyvalue-space-efficient-kv-store.md): How the data structure works
- [YKeyValueLww Tombstones Are Practically Free](./ykeyvalue-lww-tombstones-are-free.md): Delete/reinsert cycle benchmarks
- [YKeyValue vs Y.Map: Quick Decision Guide](./ykeyvalue-vs-ymap-decision-guide.md): When Y.Map wins (GC off)
- [`@epicenter/folder`](../../packages/folder/README.md): The current local file and table contract
- [Yjs Storage Efficiency: Only 30% Overhead](./yjs-storage-efficiency/README.md): YJS vs SQLite size comparison
