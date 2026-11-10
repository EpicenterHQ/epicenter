import {
	defineAction,
	defineApp,
	defineCollection,
	field,
} from '@epicenter/app';
import { assertLabels, withGmail, withStore } from './lib/mail.js';
import { pull, reconcilePass } from './lib/reconcile.js';

const views = defineCollection({
	path: 'views/{name}.md',
	description: 'saved search',
	fields: {
		query: field.text({ description: 'The search, as mail search takes it' }),
		title: field.text({
			optional: true,
			description: 'What the view is called on screen',
		}),
	},
});
const read = {
	readOnlyHint: true,
	destructiveHint: false,
	openWorldHint: false,
};
const localWrite = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};
const providerWrite = { ...localWrite, openWorldHint: true };

export default defineApp({
	description:
		'Mail over a synthetic Gmail mailbox: a local SQLite mirror to search, saved views as Markdown, and label changes kept until delivered',
	collections: { views },
	actions: {
		views: views.actions(),
		refresh: defineAction({
			description: 'Refresh the mirror from the synthetic mailbox',
			input: {},
			annotations: providerWrite,
			run: () => withGmail(pull),
		}),
		search: defineAction({
			description: 'Search mail, optionally refining a saved view',
			input: {
				query: field.text({ optional: true }),
				view: field.text({ optional: true }),
				limit: { ...field.integer({ min: 1 }), default: 50 },
			},
			positional: ['query'],
			annotations: read,
			run: async ({ query, view, limit }) => {
				const saved =
					view === undefined
						? undefined
						: await views.get({
								path: view.startsWith('views/')
									? view
									: views.pathOf({ name: view }),
							});
				if (view !== undefined && !saved)
					throw new Error(`There is no saved view "${view}"`);
				if (saved && saved.query === undefined)
					throw new Error(`The saved view ${saved.path} has no valid query`);
				const effective = [saved?.query, query]
					.filter((part) => part !== undefined && part !== '')
					.join(' ');
				return withStore((store) => ({
					query: effective,
					...(saved
						? { view: { path: saved.path, title: saved.title ?? saved.name } }
						: {}),
					...store.search(effective, limit),
					refreshedAt: store.status().refreshedAt,
					pending: store.pendingSummary().count,
				}));
			},
		}),
		show: defineAction({
			description: 'Read a message from the mirror',
			input: { id: field.text() },
			positional: ['id'],
			annotations: read,
			run: ({ id }) => withStore((store) => store.show(id)),
		}),
		labels: defineAction({
			description: 'List labels and their effective message counts',
			input: {},
			annotations: read,
			run: () => withStore((store) => store.labelCounts()),
		}),
		label: defineAction({
			description:
				'Record the label change on this computer; mail reconcile delivers it',
			input: { ids: field.tags(), add: field.tags(), remove: field.tags() },
			positional: ['ids'],
			annotations: localWrite,
			run: (input) => withStore((store) => assertLabels(store, input)),
		}),
		reconcile: defineAction({
			description: 'Deliver pending label changes and refresh the mirror',
			input: {},
			annotations: providerWrite,
			run: () =>
				withGmail(async (store, gmail) => {
					const result = await reconcilePass(store, gmail);
					if (result.failure)
						throw new Error(
							`Delivery stopped: ${result.failure}. ${result.pending} label changes are still pending; run epicenter mail reconcile again`,
						);
					return result;
				}),
		}),
		status: defineAction({
			description: 'Show mirror freshness and pending delivery',
			input: {},
			annotations: read,
			run: () => withStore((store) => store.status()),
		}),
	},
});
