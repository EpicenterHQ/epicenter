# `@epicenter/data`

`@epicenter/data` is the local-first universal-record client and replica. The
durable address is always:

```ts
type RecordAddress = {
	namespace: string;
	collection: string;
	recordKey: string;
};
```

The protocol stores records. A Lens is a pure, release-local interpretation of
those records as typed table rows or named values. A Lens does not create a
storage owner, a sync scope, an index, or a query API.

## Define and bind a Lens

Import application-facing definitions from `@epicenter/data/record`:

```ts
import {
	defineLens,
	defineTable,
	defineValues,
} from '@epicenter/data/record';
import { field } from '@epicenter/field';

export const notesLens = defineLens({
	namespace: 'com.example.notes',
	title: 'Notes',
	description: 'Notes and display preferences.',
	collections: {
		notes: defineTable({
			title: 'Notes',
			fields: {
				title: field.string(),
				archived: field.boolean(),
			},
			optional: [],
		}),
		preferences: defineValues({
			title: 'Preferences',
			values: { compact: field.boolean() },
		}),
	},
});
```

Open one adapter-owned Epicenter, then bind one or more Lenses:

```ts
import { openBunRecordEpicenter } from '@epicenter/data/bun';

await using epicenter = await openBunRecordEpicenter({
	directory: '/app/data',
});
const notes = epicenter.bind({ notes: notesLens }).notes;
```

The browser and desktop adapters expose the same Lens capabilities through
their own owner boundaries. They do not expose SQLite or a generic RPC proxy to
applications.

## Tables

Tables provide typed create, get, patch, delete, complete traversal,
subscriptions, one row-owned document, and at most one immutable blob per
record:

```ts
const created = await notes.notes.create({
	title: 'First note',
	archived: false,
});

await notes.notes.update(created.id, { archived: true });

for await (const entry of notes.notes.entries()) {
	if (entry.error !== null) {
		// Preserve or report the nonconforming stored record.
		continue;
	}
	console.log(entry.data.title);
}
```

`scan()` consumes the complete classified traversal and returns conforming rows
separately from nonconforming records. `entries()` keeps memory bounded and lets
the caller stop early. Public Lenses do not expose cursors or raw pages.

Top-level patches compose independently. Put fields that must replace as one
unit inside one bounded JSON field. Use the row document only when independent
interior edits must survive, such as collaborative prose. Use the blob plane
for large immutable bytes.

## Values

A values collection maps each declared name to one structural record key:

```ts
await notes.preferences.compact.set(true);
const compact = await notes.preferences.compact.get();
await notes.preferences.compact.unset();
```

Values are Lens projections over records, not a separate durable protocol
kind.

## Documents and blobs

Each live table record can own one bounded Yjs document:

```ts
await using document = await notes.notes.openDocument(created.id);
document.get('content').insert(0, 'Hello');
await document.whenDurable();
```

Each live table record can also own one write-once immutable blob through
`table.blob`. Document and blob publication remain automatic authority
obligations until they settle or are explicitly classified as parked work.

## Package surfaces

- `@epicenter/data/record`: Lenses, record types, sync types, and public table
  and value capabilities.
- `@epicenter/data/bun`: the Bun record owner and raw-file blob store.
- `@epicenter/data/browser-record`: the browser record owner.
- `@epicenter/data/browser-home`: trusted browser snapshot capture.
- `@epicenter/data/desktop-record`: the WebView client protocol.
- `@epicenter/data/desktop-record-owner`: the trusted desktop owner.
- `@epicenter/data/protocol/v1`: the structured record protocol kernel.
- `@epicenter/data/document-v1` and `@epicenter/data/blob-v1`: bounded
  publication contracts.
- `@epicenter/data/portable`: identity-free Backup and Proposal artifacts.

There is no legacy package-root API, kinded row/value protocol, public SQL
handle, or application-facing paging primitive.
