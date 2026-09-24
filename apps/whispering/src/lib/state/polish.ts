import { connectionLabel } from '@epicenter/app-shell/inference-picker';
import type { ResolvedInferenceTarget } from '@epicenter/app-shell/inference-target';
import { resolveCompletionTarget } from '../operations/completion.js';
import { DEVICE_DEFAULTS } from '../operations/settings.js';
import { resolveTranscriptionTarget } from '../operations/transcribe.js';
import type { WhisperingApp } from '../whispering/app.js';
import { local } from '../whispering/local.js';

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

export function polishStatus(app: WhisperingApp): PolishStatus {
	const state = resolveCompletionTarget(app);
	if (!(local.kv.get('polishEnabled') ?? DEVICE_DEFAULTS.polishEnabled))
		return 'off';
	return state ? 'on' : 'needs-connection';
}

/**
 * The inference destinations the UI shows for the current Polish configuration: where
 * audio is transcribed and where Polish sends transcript text. Assembled once
 * here, beside {@link polishStatus}, so the Polish controls only render the
 * derived sentence instead of each reconstructing it from settings and the
 * resolved completion target. Read at use per ADR 0012.
 */
export function polishDestination(app: WhisperingApp): string {
	const state = resolveCompletionTarget(app);
	const audioTarget = resolveTranscriptionTarget(app);
	const audio = !audioTarget
		? 'No transcription connection is selected.'
		: audioTarget.source === 'runtime'
			? 'Transcribed on this device.'
			: `Transcription via ${connectionLabel(audioTarget.client.baseURL)}.`;
	const text = state
		? `Cleanup via ${completionDestination(state)}.`
		: 'Cleanup is not ready; the original transcript is kept.';
	return `${audio} ${text}`;
}

/** Label the selected text destination without exposing URL credentials. */
export function completionDestination(
	target: ResolvedInferenceTarget | null,
): string | undefined {
	if (!target || target.source === 'runtime') return undefined;
	return target.source === 'account'
		? new URL(target.client.baseURL).host
		: connectionLabel(target.client.baseURL);
}
