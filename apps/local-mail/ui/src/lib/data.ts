import { defineApp, defineTable, field } from '@epicenter/app';
import type { App } from '@epicenter/app/open';

export const mailDefinition = defineApp({
	id: 'so.epicenter.local-mail',
	title: 'Local Mail',
	kv: {},
	tables: {
		savedQueries: defineTable({ name: field.string(), sql: field.string() }),
	},
});

export type MailData = NonNullable<
	App<typeof mailDefinition>['account']
>['personal'];
