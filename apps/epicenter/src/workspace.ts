import {
	type BoundLens,
	defineLens,
	defineTable,
	type RowFor,
} from '@epicenter/data/runtime';
import { field } from '@epicenter/field';
import { honeycrispLens } from '@epicenter/honeycrisp';

/** Home's release-local interpretation of its conversation namespace. */
export const homeLens = defineLens({
	namespace: 'so.epicenter.home',
	title: 'Home',
	description: 'Durable conversations for the Epicenter Home session.',
	collections: {
		conversations: defineTable({
			title: 'Conversations',
			fields: {
				title: field.string(),
				model: field.string(),
				createdAt: field.instant(),
				updatedAt: field.instant(),
			},
			optional: [],
		}),
	},
});

export type Conversation = RowFor<
	(typeof homeLens.collections)['conversations']
>;
export type ConversationsData = Pick<
	BoundLens<typeof homeLens>,
	'conversations'
>;
export type HoneycrispData = Pick<
	BoundLens<typeof honeycrispLens>,
	'folders' | 'notes'
>;
