import { openApp } from '@epicenter/app/open';
import { createDeparture } from '@epicenter/app-shell/departure';
import { createBrowserInferenceSelections } from '@epicenter/app-shell/inference-selections';
import { Ok, trySync } from 'wellcrafted/result';
import { authStartup } from './auth.js';
import { vocabDefinition } from './data.js';

// Imported only after the application route mounts. Module lifetime fixes
// both the Account and App across navigation in this document.
const auth = authStartup.auth;
export const account = auth?.state.account;
const shouldOpen =
	account !== undefined && !new URLSearchParams(location.search).has('connect');
export const selections = shouldOpen
	? createBrowserInferenceSelections('vocab', account)
	: null;
export const opening = shouldOpen
	? openApp(vocabDefinition, { account }).catch((cause) => {
			trySync({
				try: () => selections?.[Symbol.dispose](),
				catch: () => Ok(undefined),
			});
			throw cause;
		})
	: undefined;
export const departure = createDeparture({
	opening,
	auth: opening ? (auth ?? undefined) : undefined,
	account,
	beforeClose() {
		selections?.[Symbol.dispose]();
	},
});
