/**
 * Compile-time tests for the public typed Data API.
 *
 * These assertions prove row inference, create/update inputs, and the
 * universal row-document capability directly from inert definitions.
 */
import { field } from '@epicenter/field';
import { defineTable, type Epicenter, optional, type RowFor } from './index.js';

type Equal<TLeft, TRight> =
	(<TValue>() => TValue extends TLeft ? 1 : 2) extends <
		TValue,
	>() => TValue extends TRight ? 1 : 2
		? true
		: false;
type Expect<TValue extends true> = TValue;

const ordinary = defineTable({
	namespace: 'so.epicenter.types',
	table: 'ordinary',
	fields: {
		title: field.string(),
		note: optional(field.string()),
	},
});

export type _RowDerivesRequiredAndOptionalFields = Expect<
	Equal<
		RowFor<typeof ordinary>,
		{ id: string } & { title: string } & { note?: string }
	>
>;

declare const epicenter: Epicenter;
const bound = epicenter.bind({
	tables: { ordinary },
	values: {},
});

// Every table lens exposes the row-owned document at the row's own address.
await bound.tables.ordinary.openDocument('aaaaaaaaaaaaaaaaaaaaaaaa');

await bound.tables.ordinary.create({ title: 'valid' });
await bound.tables.ordinary.update('aaaaaaaaaaaaaaaaaaaaaaaa', {
	note: undefined,
});

// @ts-expect-error Row ids are minted by the runtime.
await bound.tables.ordinary.create({ id: 'caller-id', title: 'invalid' });

await bound.tables.ordinary.update('aaaaaaaaaaaaaaaaaaaaaaaa', {
	// @ts-expect-error Required fields cannot be removed with undefined.
	title: undefined,
});
