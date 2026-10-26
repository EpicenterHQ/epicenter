# 0553. A page's own writes keep its folder cache in step, and folder queries carry their read policy

- **Status:** Superseded
- **Date:** 2026-10-15
- **Superseded by:** [ADR-0689](0689-a-folder-shows-what-landed-a-draft-holds-what-was-typed-until-it-lands.md).
- **Amended by:** [ADR-0554](0554-a-field-edit-sets-fields-on-the-file-as-it-is-now.md): a field edit sets fields on the file as it is now, as an `UPDATE` does; only document editors keep a starting version.
- **Amends:** [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md) at "a page's own save updates its cache directly" and at TanStack's focus refetch.
- **Built:** all of it, in `@epicenter/folder/query` and `@epicenter/folder/svelte`, with Todos, Capture, Honeycrisp, Whispering, Vocab, the Git lab, and the Folders window on it.

## Context

ADR-0548 said a page's own save updates its cache directly and is not reported
to that page. Moving six apps onto `folderOptions` showed that a save changes
more than the entry it writes:

- Saving a row changes the history's status, the listing a file's size
  appears in, and the text of the row's file. Every app that showed Git
  status invalidated it by hand after each save, which is the per-app refresh
  logic 0548 set out to delete.
- A read that started before a save could land after it and put the older file
  back in the cache.
- A caller that set `onSuccess` on a write's options replaced the callback
  that updated the cache, so the cache silently stopped following its writes.
- `files.write` refetched the file it had just written.

Each app also repeated the same read settings (`refetchOnWindowFocus: false`,
query defaults under the folder's key), its own `whenIdle`, its own way to run
a mutation outside a component, and its own "Restore theirs" loop. Apps kept
text under `files.read`'s key with extra segments to ride its invalidation,
and Capture cached a different data shape under that key.

## Decision

**A page's own write marks stale everything a change to its paths would, except
what it set itself.** The write sets the entries its result decides (the row,
the file's read and text, where a view holds them), then invalidates the rest
of `pathFilter(paths)`, the history's status included. No app refreshes
anything after a save.

**A write's cache update belongs to the write.** Writes update the cache inside
their `mutationFn`, so a caller's `onSuccess`, `onError`, and `onSettled` add
to it rather than replace it. A read in flight for an entry a write sets is
cancelled and run again.

**Folder queries carry their read policy.** Every query option from
`folderOptions` sets `staleTime: Infinity`, `refetchOnWindowFocus: false`,
`retry: false`, and `networkMode: 'always'`: the change channel is the only
reason to reread. Apps set none of these.

**The query layer offers the reads apps were improvising.**

```ts
folder$.files.text(path)                     // a file as editable text, up to 1 MiB
folder$.query({ paths, key, queryFn })       // a page's own query, stale when those paths change
runMutation(client, options, variables)      // run write options outside a component
whenIdle(client)                             // wait until no folder write is pending
```

**A draft's save hands back the save that restores theirs.** `onSaved(saved,
restore)` gives each landed save and, when it replaced values, one more save
that puts theirs back. A text draft sends `{ base, content }` and takes the
folder's definition, so restoring text at a row path or `kv.json` merges as its
kind.

**`folderOptions(folder)` infers its tables and settings from the folder.** No
caller names the definition's type.

## Consequences

- Deleted: each app's status invalidation after saves, its read defaults, its
  `whenIdle` and mutation runner, its text query key, and its restore loop:
  about 450 lines across six apps.
- A save also rereads an observed `files.list`, since sizes change.
- Only observed queries refetch on invalidation, as TanStack does. A page that
  reads through `getQueryData` holds its own observers.
- The root's one `onFilesChanged` line stays in each app, as ADR-0548 asks.
- Not settled here: after a save whose reply was lost (`Unconfirmed`), the next
  save can name the page's own earlier write as replaced.

## Considered alternatives

- **Each app invalidates status and text after its own saves.** Six copies of
  refresh logic, the thing 0548 removed.
- **Writes update the cache in `onSuccess`.** A caller's own `onSuccess`
  replaces it.
- **Apps set the read policy on their `QueryClient`.** Every app repeated it,
  and a folder query in a client without it refetched on focus.
