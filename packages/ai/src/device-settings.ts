/**
 * `#device-settings` in a browser: what `@epicenter/ai` keeps of this
 * device's settings, in this browser's storage for the site. The desktop's
 * is `device-settings.tauri.ts`; the build picks one (the `tauri`
 * condition), so an app calls the same `customEndpoints()` and
 * `modelChoices()` in both.
 *
 * - The person's connected endpoints, keys included, sent by the page.
 * - The model chosen for each job.
 */
import { createAiConnections } from './ai-connections.js';
import {
	type ChoicesPlace,
	createModelChoices,
	type ModelChoices,
	type SavedChoices,
	validateModelChoices,
} from './choices.js';
import { type CustomEndpoints, customEndpointsOf } from './custom-endpoints.js';
import type { ModelChoice } from './open-ai.js';

/** This browser's connections live under this key. */
const BROWSER_STORAGE_KEY = 'epicenter/ai';

/** The connections a person made in this browser, kept in its storage for this site, keys included. */
export function createBrowserConnections() {
	return createAiConnections({
		storage: window.localStorage,
		storageKey: BROWSER_STORAGE_KEY,
		locks: navigator.locks,
		publishStorage() {
			window.dispatchEvent(
				new CustomEvent('epicenter-ai-connections', {
					detail: BROWSER_STORAGE_KEY,
				}),
			);
		},
		subscribeStorage(listener) {
			const changed = (event: StorageEvent) => {
				if (
					event.storageArea === window.localStorage &&
					(event.key === `${BROWSER_STORAGE_KEY}.app-ai-connections` ||
						event.key === null)
				)
					listener();
			};
			const local = (event: Event) => {
				if ((event as CustomEvent<string>).detail === BROWSER_STORAGE_KEY)
					listener();
			};
			window.addEventListener('storage', changed);
			window.addEventListener('epicenter-ai-connections', local);
			return () => {
				window.removeEventListener('storage', changed);
				window.removeEventListener('epicenter-ai-connections', local);
			};
		},
	});
}

/** The person's connected endpoints on this device, as one entry of `openAi([...])`. */
export function customEndpoints(): CustomEndpoints {
	return customEndpointsOf(async () => createBrowserConnections());
}

/** The key this browser keeps the model choices under. */
const CHOICES_KEY = `${BROWSER_STORAGE_KEY}.model-choices`;

/** The model choices saved in this browser: `{ version: 1, choices }` under `CHOICES_KEY`. */
function readBrowserChoices(): SavedChoices {
	const raw = window.localStorage.getItem(CHOICES_KEY);
	if (raw === null) return {};
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error('Invalid persisted model choices.');
	}
	const entry = value as Record<string, unknown> | null;
	if (
		!entry ||
		typeof entry !== 'object' ||
		entry.version !== 1 ||
		Object.keys(entry).some((key) => !['version', 'choices'].includes(key))
	)
		throw new Error('Invalid persisted model choices.');
	return validateModelChoices(entry.choices);
}

/** This browser's storage for the site, told of another tab's change by the `storage` event. */
const browserChoices: ChoicesPlace = {
	read: async () => readBrowserChoices(),
	async save(job: string, choice: ModelChoice) {
		const next = { ...readBrowserChoices(), [job]: choice };
		window.localStorage.setItem(
			CHOICES_KEY,
			JSON.stringify({ version: 1, choices: next }),
		);
		return next;
	},
	watch(listener) {
		// Off a page (a worker, a test) there is no other tab to hear; `read` says why nothing is saved.
		if (typeof window === 'undefined') return () => {};
		const changed = (event: StorageEvent) => {
			if (
				event.storageArea === window.localStorage &&
				(event.key === CHOICES_KEY || event.key === null)
			)
				listener();
		};
		window.addEventListener('storage', changed);
		return () => window.removeEventListener('storage', changed);
	},
};

/**
 * The model this device's person chose for each job, kept in this browser's
 * storage for the site; `defaults` answers a job none was chosen for.
 */
export function modelChoices<TJob extends string = string>(
	defaults: Partial<Record<TJob, ModelChoice>> = {},
): ModelChoices<TJob> {
	return createModelChoices(browserChoices, defaults);
}
