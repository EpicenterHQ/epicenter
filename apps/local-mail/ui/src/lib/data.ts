import { defineStore, defineTable, field } from '@epicenter/app';
import type { PersonalStore } from '@epicenter/app/open';

export const mailDefinition = defineStore({
	id: 'so.epicenter.local-mail',
	title: 'Local Mail',
	kv: {},
	tables: {
		savedQueries: defineTable({
			fields: { name: field.string(), sql: field.string() },
		}),
	},
});

export type MailData = PersonalStore<typeof mailDefinition>;
