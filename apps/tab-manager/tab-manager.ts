import { InstantString } from '@epicenter/field';
import {
	defineActions,
	defineMutation,
} from '@epicenter/workspace';
import {
	type AsyncWorkspace,
	defineTable,
	field,
	type Id,
	nullable,
	type RowFor,
} from '@epicenter/workspace/sqlite';
import Type from 'typebox';
import type { Brand } from 'wellcrafted/brand';

export const TAB_MANAGER_APP_ID = 'epicenter-tab-manager';

export type WebCaptureId = Id & Brand<'WebCaptureId'>;

/** The synchronized inbox of pages a user explicitly captured from a browser. */
export const webCapturesTable = defineTable({
	fields: {
		id: field.id<WebCaptureId>(),
		url: field.string({ minLength: 1 }),
		title: field.string(),
		favIconUrl: nullable(field.string()),
		capturedAt: field.instant(),
	},
});

export type WebCapture = RowFor<typeof webCapturesTable>;
export type TabManagerWorkspace = AsyncWorkspace<{
	webCaptures: typeof webCapturesTable;
}>;

type BrowserTabs = {
	open(url: string): Promise<void>;
};

/** Compose capture, open, and discard over one opened inbox and browser. */
export function createTabManagerActions(
	{ tables }: Pick<TabManagerWorkspace, 'tables'>,
	browserTabs: BrowserTabs,
) {
	return defineActions({
		/** Capture a browser page without changing the browser-owned live tab. */
		web_captures_capture: defineMutation({
			description: 'Capture a page for later',
			input: Type.Object({
				url: webCapturesTable.columns.url,
				title: webCapturesTable.columns.title,
				favIconUrl: webCapturesTable.columns.favIconUrl,
			}),
			handler: async ({ url, title, favIconUrl }): Promise<WebCaptureId> => {
				const capture = await tables.webCaptures.create({
					url,
					title,
					favIconUrl,
					capturedAt: InstantString.now(),
				});
				return capture.id;
			},
		}),

		/** Open a capture and consume it only after the browser accepts the URL. */
		web_captures_open: defineMutation({
			description: 'Open and consume a captured page',
			input: Type.Object({
				id: webCapturesTable.columns.id,
				url: webCapturesTable.columns.url,
			}),
			handler: async ({ id, url }): Promise<void> => {
				await browserTabs.open(url);
				await tables.webCaptures.remove(id);
			},
		}),

		/** Discard a capture without opening it. */
		web_captures_discard: defineMutation({
			description: 'Discard a captured page',
			input: Type.Object({ id: webCapturesTable.columns.id }),
			handler: async ({ id }): Promise<void> => {
				await tables.webCaptures.remove(id);
			},
		}),
	});
}

export type TabManagerActions = ReturnType<typeof createTabManagerActions>;
