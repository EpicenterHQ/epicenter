import { resolveCompletionState } from './completion.svelte.js';
import { describeTranscriptionDestinationFromConfig } from '../operations/transcription-target.js';
import { deviceConfig } from './device-config.svelte.js';
import { settings } from '../operations/settings.js';

/**
 * The Polish control's effective state, derived from two independent facts:
 * intent (`polishEnabled`, the toggle) and capability (the selected provider can
 * serve a completion). Speed mode is `off`; `on` means a pass will run; and
 * `needs-connection` is the "wanted but blocked" state, intent without capability,
 * which a bare boolean used to hide by collapsing it into the same `false` as
 * `off`. The UI reads this so the Settings toggle and the home chip can show
 * *why* Polish is or is not running, instead of a toggle that reads "on" while
 * the pipeline silently ships raw. Configuring a provider is capability, not
 * consent, so the two facts stay separate concepts even though both must hold to
 * run. Read at use per ADR 0012; nothing is cached.
 */
export type PolishStatus = 'off' | 'on' | 'needs-connection';

export function polishStatus(): PolishStatus {
	const state = resolveCompletionState();
	if (!settings.get('polishEnabled')) return 'off';
	return state.canRun ? 'on' : 'needs-connection';
}

/**
 * The inference destinations the UI shows for the current Polish configuration: where
 * audio is transcribed and where Polish sends transcript text. Assembled once
 * here, beside {@link polishStatus}, so the Polish controls only render the
 * derived sentence instead of each reconstructing it from settings and the
 * resolved completion target. Read at use per ADR 0012.
 */
export function polishDestination(): string {
	const audio = describeTranscriptionDestinationFromConfig({
		service: settings.get('transcriptionService'),
		getDeviceConfig: deviceConfig.get,
	});
	const state = resolveCompletionState();
	const text = state.canRun
		? `Text transformation via ${state.destination}.`
		: 'Polish is not ready; the original transcript is kept.';
	return `${audio} ${text}`;
}
