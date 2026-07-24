/**
 * Compile-time tests for Lens definition inference.
 *
 * These assertions prove literal collection, field, optional, and value keys
 * survive authoring while create and update constraints reject invalid shapes.
 */
import { field } from '@epicenter/field';

import {
	type ConstrainedUpdate,
	type CreateInputFor,
	defineLens,
	defineTable,
	defineValues,
	type RowFor,
	type ValueTypeFor,
} from './index.js';

type Equal<TLeft, TRight> =
	(<TValue>() => TValue extends TLeft ? 1 : 2) extends <
		TValue,
	>() => TValue extends TRight ? 1 : 2
		? true
		: false;
type Expect<TValue extends true> = TValue;

const notes = defineTable({
	title: 'Notes',
	fields: {
		title: field.string(),
		rank: field.integer(),
		note: field.string(),
	},
	optional: ['note'],
});

const settings = defineValues({
	title: 'Settings',
	values: { theme: field.select(['light', 'dark']) },
});

const lens = defineLens({
	namespace: 'so.epicenter.types',
	title: 'Types',
	description: 'Type fixture.',
	collections: { notes, settings },
});

export type _CollectionsKeepLiteralKeys = Expect<
	Equal<keyof typeof lens.collections, 'notes' | 'settings'>
>;
export type _RowDerivesRequiredAndOptionalFields = Expect<
	Equal<
		RowFor<typeof notes>,
		{ id: string } & { title: string; rank: number } & { note?: string }
	>
>;
export type _CreateInputOmitsId = Expect<
	Equal<
		CreateInputFor<typeof notes>,
		{ title: string; rank: number } & { note?: string } & { id?: never }
	>
>;
export type _ValueTypeUsesDeclaredRecordKey = Expect<
	Equal<ValueTypeFor<typeof settings, 'theme'>, 'light' | 'dark'>
>;

declare function update<const TChanges extends Record<string, unknown>>(
	changes: TChanges & ConstrainedUpdate<typeof notes, TChanges>,
): void;

update({ title: 'next', note: undefined });

// @ts-expect-error Required fields cannot be unset.
update({ title: undefined });

// @ts-expect-error Unknown fields cannot be updated.
update({ future: true });

defineTable({
	title: 'Invalid optional',
	fields: { title: field.string() },
	// @ts-expect-error Optional entries must be field keys.
	optional: ['missing'],
});
