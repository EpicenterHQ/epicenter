/**
 * The one draft of the connection settings: for transcription and for text,
 * a base URL, a default model, and what to do with the key. All of it stays
 * on this device; none of it is written to the folder, so it is not a file
 * edited through a folder draft. It is a form being composed: `$state`
 * until its explicit Save. Departure does not wait for the connection request.
 *
 * The product owns it, so the form is the same draft wherever it is shown:
 * what was typed in the header's Settings is what the form beside the
 * recorder shows, and each connection has one save.
 *
 * Untouched fields follow the saved connection. Typed fields stay with the
 * form until their explicit save succeeds; a completed save clears only
 * its submitted input, so later typing survives. A connection not set up yet
 * starts from the device's defaults; nothing is sent to those, or saved,
 * until Save. The key is never read back: the draft holds only what was typed
 * since the last save, and whether to keep, replace, or remove the saved one. Keeping is
 * offered only for the base URL the key was saved for, by the same rule the
 * storage applies.
 */

import type { ConnectionsInfo } from './connections.js';
import {
	applyConnectionChange,
	type ConnectionChange,
	type ConnectionInfo,
	type KeyChange,
	type Operation,
} from './connections.js';
import type { WhisperingServices } from './platform/types.js';

/** Why a save did not finish, as a heading and the reason. */
export type SettingsSaveProblem = {
	readonly title: string;
	readonly description: string;
};

export type KeyAction = KeyChange['action'];

export function createSettingsDraft(
	defaults: WhisperingServices['connections']['defaults'],
	connections: () => ConnectionsInfo | undefined,
	saveConnection: (
		operation: Operation,
		change: ConnectionChange,
	) => Promise<string | undefined>,
) {
	function createConnectionDraft(operation: Operation) {
		const saved = $derived<ConnectionInfo | undefined>(
			connections()?.[operation],
		);
		const startDefaults = defaults[operation];
		/** Where an unconfigured form starts: the defaults. */
		const start = $derived.by(() => {
			if (operation === 'transcription')
				return { baseUrl: startDefaults.baseUrl, model: startDefaults.model };
			// Text often goes to the same provider as transcription.
			return {
				baseUrl: connections()?.transcription?.baseUrl ?? startDefaults.baseUrl,
				model: startDefaults.model,
			};
		});
		/** Explicit input stays independent of refreshed saved values. */
		type Input = {
			readonly baseUrl: string;
			readonly model: string;
			readonly keyAction: KeyAction;
			readonly key: string;
		};
		const configured = $derived<Input>({
			baseUrl: saved?.baseUrl ?? start.baseUrl,
			model: saved?.model ?? start.model,
			keyAction: saved?.keyPresent ? 'keep' : 'replace',
			key: '',
		});
		let typed = $state.raw<Partial<Input>>({});
		const input = $derived({ ...configured, ...typed });
		let saving = $state(false);

		/** The change Save would make: a blank new key where none is saved means no key. */
		const change = $derived.by((): ConnectionChange => {
			const keyChange: KeyChange =
				input.keyAction === 'replace' &&
				input.key.trim() === '' &&
				!saved?.keyPresent
					? { action: 'remove' }
					: input.keyAction === 'replace'
						? { action: 'replace', key: input.key }
						: { action: input.keyAction };
			return { baseUrl: input.baseUrl, model: input.model, key: keyChange };
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
				return input.baseUrl;
			},
			set baseUrl(value: string) {
				typed = { ...typed, baseUrl: value };
			},
			get model() {
				return input.model;
			},
			set model(value: string) {
				typed = { ...typed, model: value };
			},
			get keyAction() {
				return input.keyAction;
			},
			set keyAction(value: KeyAction) {
				typed = { ...typed, keyAction: value };
			},
			get key() {
				return input.key;
			},
			set key(value: string) {
				typed = { ...typed, key: value, keyAction: input.keyAction };
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
					input.baseUrl !== configured.baseUrl ||
					input.model !== configured.model ||
					input.keyAction !== configured.keyAction ||
					input.key !== ''
				);
			},
			/**
			 * Save this connection on the device. Nothing is sent to the endpoint
			 * and nothing is written to the folder. Input typed while the save is
			 * under way stays in the form for its next explicit save.
			 */
			async save(): Promise<SettingsSaveProblem | undefined> {
				if (saving) return undefined;
				const submitted = change;
				const submittedInput = input;
				saving = true;
				try {
					const refused = await saveConnection(operation, submitted);
					if (refused)
						return {
							title: `Could not save the ${operation} connection`,
							description: refused,
						};
					// Saved values may have changed while this form was still being edited.
					// Drop only the submission, keeping each newer field and its key choice.
					const newerKey =
						typed.key !== undefined && typed.key !== submittedInput.key;
					typed = {
						...(typed.baseUrl !== undefined &&
							typed.baseUrl !== submittedInput.baseUrl && {
								baseUrl: typed.baseUrl,
							}),
						...(typed.model !== undefined &&
							typed.model !== submittedInput.model && { model: typed.model }),
						...(newerKey && { key: typed.key }),
						...(typed.keyAction !== undefined &&
							(typed.keyAction !== submittedInput.keyAction || newerKey) && {
								keyAction: typed.keyAction,
							}),
					};
					return undefined;
				} finally {
					saving = false;
				}
			},
		};
	}

	return {
		transcription: createConnectionDraft('transcription'),
		text: createConnectionDraft('text'),
	};
}
export type SettingsDraft = ReturnType<typeof createSettingsDraft>;
export type ConnectionDraft = SettingsDraft['transcription'];
