import { defineApp, defineTable, field } from '@epicenter/app';

export const mailDefinition = defineApp({
	id: 'so.epicenter.local-mail',
	title: 'Local Mail',
	kv: {},
	tables: {
		savedQueries: defineTable({ name: field.string(), sql: field.string() }),
	},
});
