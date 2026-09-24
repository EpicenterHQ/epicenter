import { createPersistedMap, defineEntry } from '@epicenter/svelte';
import { type } from 'arktype';
import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { os } from '#platform/os';
import { BITRATES_KBPS, DEFAULT_BITRATE_KBPS } from '$lib/constants/audio';
import { report } from '$lib/report';
import type { KeyBinding } from '$lib/utils/key-binding';

const log = createLogger('whispering/device-config');

// ── Global shortcut binding shape ────────────────────────────────────────────

/**
 * Runtime shape of a stored global shortcut: the structured `KeyBinding` the
 * frontend resolves to a `tauri-plugin-global-shortcut` accelerator (physical-key
 * space). `modifiers` is strictly enumerated; `keys` is validated as strings
 * here. A binding that is not a registrable chord produces no accelerator and is
 * refused before it registers (ADR-0117), so a bad or unsupported gesture is
 * never registered.
 */
const globalBinding = type({
	modifiers: "('ctrl' | 'alt' | 'shift' | 'meta' | 'fn')[]",
	keys: 'string[]',
}).or('null');

// Default global gestures, not mnemonic app hotkeys. These are plain chords the
// `tauri-plugin-global-shortcut` backend registers with no Accessibility grant,
// the only global-shortcut backend on every platform (ADR-0117). Every default
// binding is distinct.
//
// Toggle recording is the out-of-the-box gesture: press once to start and again
// to stop. A chord is the right tool for a toggle; its press effort resists
// accidental triggers. Push-to-talk ships unbound: bind a chord for it in
// settings if you want a held key (Fn and modifier-only holds are not supported).
//
//   macOS:   Cmd + Shift + Space  = toggle,  Cmd + .          = cancel
//   Windows: Ctrl + Shift + Space = toggle,  Ctrl + Shift + . = cancel
//
// Cancel is the platform cancel chord (Cmd + . on macOS, the system cancel
// gesture since classic Mac OS; Ctrl + Shift + . elsewhere); it carries a
// modifier so it is safe to register globally. Exported so the reset path in platform/system-shortcuts.tauri.ts
// shares this one source of truth.
const TOGGLE_MODIFIERS: KeyBinding['modifiers'] = os.isApple
	? ['meta', 'shift']
	: ['ctrl', 'shift'];

const CANCEL_MODIFIERS: KeyBinding['modifiers'] = os.isApple
	? ['meta']
	: ['ctrl', 'shift'];

export const DEFAULT_GLOBAL_BINDINGS = {
	pushToTalk: null,
	toggleManualRecording: { modifiers: TOGGLE_MODIFIERS, keys: ['space'] },
	cancelRecording: { modifiers: CANCEL_MODIFIERS, keys: ['dot'] },
	toggleVadRecording: null,
	// Focused-reach command (ADR-0052): its reach ceiling clamps any key to the
	// in-app store, so the router never writes this global slot. It stays here only
	// so the system backend's all-commands sync keeps one entry per command;
	// always null.
	openSettings: null,
} satisfies Record<string, KeyBinding | null>;

// ── Per-key definitions ──────────────────────────────────────────────────────

/** Hardware and shortcut preferences. Retired provider keys remain untouched. */
const DEVICE_DEFINITIONS = {
	// ── Recording hardware ────────────────────────────────────────────
	'recording.cpal.deviceId': defineEntry(type('string | null'), null),
	'recording.navigator.deviceId': defineEntry(type('string | null'), null),
	'recording.navigator.bitrateKbps': defineEntry(
		type.enumerated(...BITRATES_KBPS),
		DEFAULT_BITRATE_KBPS,
	),

	// Local transcription model selection and unload policy are deliberately
	// absent: the host owns the one active local model and its lifecycle, and
	// Epicenter Home administers both (ADR-0180). They are still device-local,
	// just owned a layer down, where the model files and the accelerator are.

	// ── Global OS shortcuts (device-specific, never synced) ───────────
	// Structured KeyBinding (physical-key space) resolved to a plugin accelerator.
	// Old accelerator-string values are not migrated: they fail this schema and
	// reset to the defaults (clean break, see the note below the singleton).
	'shortcuts.global.pushToTalk': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.pushToTalk,
	),
	'shortcuts.global.toggleManualRecording': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.toggleManualRecording,
	),
	'shortcuts.global.cancelRecording': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.cancelRecording,
	),
	'shortcuts.global.toggleVadRecording': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.toggleVadRecording,
	),
	// Always null: `openSettings` is focused-reach, so the router never routes a
	// write here. Present only to keep one global slot per command for the system
	// backend's uniform sync (see DEFAULT_GLOBAL_BINDINGS.openSettings).
	'shortcuts.global.openSettings': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.openSettings,
	),
};

// ── Types ────────────────────────────────────────────────────────────────────

type DeviceConfigDefs = typeof DEVICE_DEFINITIONS;
export type DeviceConfigKey = keyof DeviceConfigDefs & string;

// ── Singleton ────────────────────────────────────────────────────────────────

const DEVICE_CONFIG_PREFIX = 'whispering.device.';

export const deviceConfig = createPersistedMap({
	prefix: DEVICE_CONFIG_PREFIX,
	definitions: DEVICE_DEFINITIONS,
	onError: (key) => {
		log.info(`Invalid device config for "${key}", using default`);
	},
	onUpdateError: (_key, error) => {
		report.error({
			title: 'Error updating device config',
			cause: {
				name: 'DeviceConfigUpdateFailed',
				message: extractErrorMessage(error),
			},
		});
	},
});

// Nothing here is migrated from a legacy format, and retired keys are orphaned
// rather than moved. Local model selections lived under
// `transcription.local.selectedModel` (and before that `transcription.*.modelPath`),
// and the unload policy under `transcription.localModelUnloadPolicy`; both are now
// host-owned (ADR-0180) and their old localStorage entries are simply ignored. The
// native recording rate also moved down to the host under ADR-0184, so the retired
// `recording.cpal.sampleRate` entry is ignored rather than migrated. The model
// files themselves are untouched in the shared Hugging Face cache, so recovery is
// one choice in Epicenter Home rather than a re-download. Global shortcuts once
// stored accelerator strings under the same key: a legacy value fails the
// `globalBinding` schema on read and falls back to the default (see
// `createPersistedMap`). Either way upgrading users get the new defaults, and we
// carry no parser for a format nothing writes anymore.
