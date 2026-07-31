/**
 * The simple case: an accounting authority whose objects map column-for-column.
 *
 * Every mapping is a `path()`, so this declaration's fingerprint gate is
 * *total*: there is no way to change what a column stores without changing the
 * fingerprint. `booksMirror.unfingerprintedPaths` is empty, and a test asserts
 * that, because "the gate covers everything here" is a property worth keeping.
 */

import { defineMirror, path, table } from '../src/index.ts';

/** What the authority hands us. Shaped after QuickBooks Online objects. */
export type Purchase = {
	Id: string;
	MetaData: { LastUpdatedTime: string };
	TotalAmt: number;
	PaymentType: string;
	AccountRef?: { value: string; name: string };
	status?: 'Deleted';
};

export type Vendor = {
	Id: string;
	MetaData: { LastUpdatedTime: string };
	DisplayName: string;
	Active: boolean;
	status?: 'Deleted';
};

export const booksMirror = defineMirror({
	name: 'quickbooks',
	tables: {
		purchases: table<Purchase>({
			key: path('Id'),
			// QuickBooks stamps ISO-8601, which sorts as text.
			version: { from: path('MetaData', 'LastUpdatedTime'), order: 'lexical' },
			tombstone: path('status'),
			columns: {
				total: { type: 'real', from: path('TotalAmt') },
				paymentType: { type: 'text', from: path('PaymentType') },
				accountId: {
					type: 'text',
					from: path('AccountRef', 'value'),
					nullable: true,
				},
				accountName: {
					type: 'text',
					from: path('AccountRef', 'name'),
					nullable: true,
				},
			},
			// Not a fingerprint input: adding this line must never cost a re-pull.
			indexes: [['accountId']],
		}),
		vendors: table<Vendor>({
			key: path('Id'),
			version: { from: path('MetaData', 'LastUpdatedTime'), order: 'lexical' },
			tombstone: path('status'),
			columns: {
				displayName: { type: 'text', from: path('DisplayName') },
				active: { type: 'integer', from: path('Active') },
			},
		}),
	},
});
