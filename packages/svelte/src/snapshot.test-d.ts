/** The generic view preserves a source's snapshot type and exposes no commands. */
import { expectTypeOf } from 'bun:test';
import type { Folder } from '@epicenter/folder';
import type {
	DocumentSnapshot,
	TextDocument,
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
expectTypeOf(snapshot.current).toEqualTypeOf<DocumentSnapshot>();
expectTypeOf(snapshot.current.text).toEqualTypeOf<string | undefined>();
// @ts-expect-error The view exposes no document commands.
snapshot.patch({ body: 'text' });
// @ts-expect-error The snapshot getter is readonly.
snapshot.current = document.getSnapshot();

declare const counter: {
	getSnapshot(): number;
	subscribe(listener: () => void): () => void;
	reset(): void;
};
const count = liveSnapshot(counter);
expectTypeOf(count.current).toEqualTypeOf<number>();
// @ts-expect-error Arbitrary source commands are not copied either.
count.reset();

// Mixed-schema selection yields the same schema-neutral text snapshot.
const folders = Type.Object({ name: Type.String() });
declare const selected:
	| TextDocument<typeof notes>
	| TextDocument<typeof folders>;
expectTypeOf(liveSnapshot(selected).current).toEqualTypeOf<
	DocumentSnapshot
>();
