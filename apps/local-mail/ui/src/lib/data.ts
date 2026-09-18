import { defineApp } from '@epicenter/app';
import { defineTable, field } from '@epicenter/data/definition';

export const mailDefinition = defineApp({
	id: 'so.epicenter.local-mail',
	title: 'Local Mail',
	kv: {},
	tables: {
		savedQueries: defineTable({ name: field.string(), sql: field.string() }),
	},
});
