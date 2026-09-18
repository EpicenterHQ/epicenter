import { defineApplication } from '@epicenter/app';
import { createDeparture } from '@epicenter/app-shell/departure';
import { createBrowserInferenceSelections } from '@epicenter/app-shell/inference-selections';
import { initializeBrowserAiSettings } from '@epicenter/app-shell/migrate-ai-settings';
import { APPS } from '@epicenter/constants/apps';
import { Ok, trySync } from 'wellcrafted/result';
import { authStartup } from './auth.js';
import { vocabDefinition } from './data.js';

// Imported only after the application route mounts. Module lifetime fixes
// both the Account and App across navigation in this document.
const auth = authStartup.auth;
export const account = auth?.state.account;
const shouldOpen =
	account !== undefined && !new URLSearchParams(location.search).has('connect');
if (shouldOpen) await initializeBrowserAiSettings('vocab');
export const selections = shouldOpen
	? createBrowserInferenceSelections('vocab')
	: null;
export const app = trySync({
	try: () =>
		account === undefined || new URLSearchParams(location.search).has('connect')
			? null
			: defineApplication({
					appId: APPS.VOCAB.id,
					settingsKey: 'vocab',
					definition: vocabDefinition,
				}).open(account),
	catch(cause) {
		// Preserve the opening failure even if subscription cleanup also fails.
		trySync({
			try: () => selections?.[Symbol.dispose](),
			catch: () => Ok(undefined),
		});
		throw cause;
	},
}).data;
void app?.ready.then(({ error }) => {
	if (error) selections?.[Symbol.dispose]();
});
export const departure = createDeparture({
	libraryReplaced: app?.libraryReplaced,
	canRetryClose: () => app?.canRetryClose ?? false,
	reload: () => location.reload(),
	auth: app && auth ? auth : undefined,
	account,
	close() {
		selections?.[Symbol.dispose]();
		return app?.close() ?? Promise.resolve();
	},
});
