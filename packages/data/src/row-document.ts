import type * as Y from '@y/y';

/** A scoped live Yjs handle whose owner controls persistence and disposal. */
export type RowDocument = {
	get: Y.Doc['get'];
	transact<TValue>(
		callback: (transaction: Y.Transaction) => TValue,
		origin?: unknown,
	): TValue;
	whenDurable(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
};
