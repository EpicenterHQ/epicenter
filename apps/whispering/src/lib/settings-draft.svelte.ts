/**
 * The one draft of the connection settings: for transcription and for text,
 * a base URL, a default model, and what to do with the key. All of it stays
 * on this device; none of it is written to the folder, so it is not a file
 * edited through the query cache. It is a form being composed: `$state`
 * until its explicit Save, which is a mutation the close waits for.
 *
 * The session owns it, so the form is the same draft wherever it is shown:
 * what was typed in the header's Settings is what the form beside the
 * recorder shows, and each connection has one save.
 *
 * The base URL and model follow the saved connection until they are typed
 * in, and follow it again when it changes. A connection not set up yet
 * starts from the workspace's defaults; nothing is sent to those, or saved,
 * until Save. The
 * key is never read back: the draft holds only what was typed since the last
 * save, and whether to keep, replace, or remove the saved one. Keeping is
 * offered only for the base URL the key was saved for, by the same rule the
 * storage applies.
 */
import {
	applyConnectionChange,
	type ConnectionChange,
	type ConnectionInfo,
	type KeyChange,
	type Operation,
} from './connections.js';
import type { Library } from './library.svelte.js';

export type SettingsDraft = ReturnType<typeof createSettingsDraft>;
export type ConnectionDraft = ReturnType<typeof createConnectionDraft>;

/** Why a save did not finish, as a heading and the reason. */
export type SettingsSaveProblem = {
	readonly title: string;
	readonly description: string;
};

export type KeyAction = KeyChange['action'];

function createConnectionDraft(library: Library, operation: Operation) {
	const saved = $derived<ConnectionInfo | undefined>(
		library.connections?.[operation],
	);
	const defaults = library.workspace.connections.defaults[operation];
	/** Where an unconfigured form starts: the defaults. */
	const start = $derived.by(() => {
		if (operation === 'transcription')
			return { baseUrl: defaults.baseUrl, model: defaults.model };
		// Text often goes to the same provider as transcription.
		return {
			baseUrl: library.connections?.transcription?.baseUrl ?? defaults.baseUrl,
			model: defaults.model,
		};
	});
	// A refreshed connections object must not reset typing when these values
	// are unchanged. Writable overrides depend on the values, not the object.
	const configuredBaseUrl = $derived(saved?.baseUrl ?? start.baseUrl);
	const configuredModel = $derived(saved?.model ?? start.model);
	const configuredKeyAction = $derived<KeyAction>(
		saved?.keyPresent ? 'keep' : 'replace',
	);
	let baseUrl = $derived(configuredBaseUrl);
	let model = $derived(configuredModel);
	let keyAction = $derived<KeyAction>(configuredKeyAction);
	let key = $state('');
	let saving = $state(false);

	/** The change Save would make: a blank new key where none is saved means no key. */
	const change = $derived.by((): ConnectionChange => {
		const keyChange: KeyChange =
			keyAction === 'replace' && key.trim() === '' && !saved?.keyPresent
				? { action: 'remove' }
				: keyAction === 'replace'
					? { action: 'replace', key }
					: { action: keyAction };
		return { baseUrl, model, key: keyChange };
	});

	/** Why Save would be refused, by the rule the storage applies; undefined when it would not. */
	const problem = $derived.by(() => {
		const current = saved && {
			baseUrl: saved.baseUrl,
			model: saved.model,
			// Stands for the saved key, which the page never sees.
			...(saved.keyPresent && { apiKey: 'saved' }),
		};
		const { error: changeError } = applyConnectionChange(
			operation,
			current,
			change,
		);
		return changeError ?? undefined;
	});

	return {
		operation,
		get saved() {
			return saved;
		},
		/** Set when this connection cannot be changed from the app. */
		get readOnlyReason() {
			return saved?.readOnlyReason;
		},
		get baseUrl() {
			return baseUrl;
		},
		set baseUrl(value: string) {
			baseUrl = value;
		},
		get model() {
			return model;
		},
		set model(value: string) {
			model = value;
		},
		get keyAction() {
			return keyAction;
		},
		set keyAction(value: KeyAction) {
			keyAction = value;
		},
		get key() {
			return key;
		},
		set key(value: string) {
			key = value;
		},
		get problem() {
			return problem;
		},
		get saving() {
			return saving;
		},
		/** Input the person has not explicitly saved. */
		get unsent() {
			return (
				baseUrl !== configuredBaseUrl ||
				model !== configuredModel ||
				keyAction !== configuredKeyAction ||
				key !== ''
			);
		},
		/**
		 * Save this connection on the device. Nothing is sent to the endpoint
		 * and nothing is written to the folder. A key typed while the save is
		 * under way is kept in the field.
		 */
		async save(): Promise<SettingsSaveProblem | undefined> {
			if (saving) return undefined;
			const submitted = change;
			const submittedKey = key;
			saving = true;
			try {
				const refused = await library.saveConnection(operation, submitted);
				if (refused)
					return {
						title: `Could not save the ${operation} connection`,
						description: refused,
					};
				if (key === submittedKey) key = '';
				return undefined;
			} finally {
				saving = false;
			}
		},
	};
}

export function createSettingsDraft(library: Library) {
	return {
		transcription: createConnectionDraft(library, 'transcription'),
		text: createConnectionDraft(library, 'text'),
	};
}
