/** The generic view preserves snapshot types and exposes no source commands. */
import { expectTypeOf } from 'bun:test';
import type { Folder } from '@epicenter/folder';
import type {
	DocumentSnapshot,
	FileDocument,
} from '@epicenter/folder/document';
import { Type } from 'typebox';
import { liveSnapshot } from './snapshot.js';

const notes = Type.Object({
	title: Type.String(),
	tags: Type.Array(Type.String()),
});
declare const folder: Folder<{ notes: typeof notes }>;
const document = folder.tables.notes.document('milk');
const snapshot = liveSnapshot(document);
expectTypeOf(snapshot.current).toEqualTypeOf<DocumentSnapshot<typeof notes>>();
const content = snapshot.current.content;
if (content?.issues === null) {
	expectTypeOf(content.fields.title).toEqualTypeOf<string>();
	// @ts-expect-error Observation preserves readonly snapshot fields.
	content.fields.tags.push('new');
}
// @ts-expect-error The view exposes no document commands.
snapshot.patch({ body: 'text' });
// @ts-expect-error The snapshot getter is readonly.
snapshot.current = document.getSnapshot();
// @ts-expect-error Observation preserves readonly snapshot properties.
snapshot.current.content = undefined;

declare const counter: {
	getSnapshot(): number;
	subscribe(listener: () => void): () => void;
	reset(): void;
};
const count = liveSnapshot(counter);
expectTypeOf(count.current).toEqualTypeOf<number>();
// @ts-expect-error Arbitrary source commands are not copied either.
count.reset();

// Mixed-schema selection preserves the precise union without a caller type argument.
const folders = Type.Object({ name: Type.String() });
declare const selected:
	| FileDocument<typeof notes>
	| FileDocument<typeof folders>;
expectTypeOf(liveSnapshot(selected).current).toEqualTypeOf<
	DocumentSnapshot<typeof notes> | DocumentSnapshot<typeof folders>
>();
