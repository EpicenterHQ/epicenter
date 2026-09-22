import type { CaptureSurface } from '$lib/constants/audio';
import type { WhisperingApp } from '$lib/whispering/app';
import { DEVICE_DEFAULTS } from '../operations/settings.js';

/**
 * Which capture surface the home page and the config header are currently
 * showing: a microphone trigger (`manual`/`vad`) or the file-import overlay
 * (`import`).
 *
 * This is a thin, transient presentation layer over the durable
 * `recordingTrigger` setting. `manual`/`vad` read straight through to that
 * setting; `import` is a module-level boolean that is never persisted (file
 * import is a one-shot, so each launch starts on your durable trigger) and
 * never written back to `recordingTrigger`. Keeping it here, rather than as a
 * third trigger value, is what lets the UI offer the three-way choice while the
 * trigger setting stays strictly `manual | vad`.
 *
 * It lives at module scope so the home tabs and the header dropdown share one
 * selection. This module is a leaf: the orchestration that runs when you switch
 * surfaces (stopping a live recorder, switching the trigger) lives in
 * `operations/recording.svelte.ts`, which calls `showImport`/`dismissImport` here.
 */
let isImportSurfaceShowing = $state(false);

export const captureSurface = {
	/** The surface on screen now: `import` while the import overlay is open,
	 *  otherwise the durable recording trigger. Reactive when called inside a
	 *  template, `$derived`, or `$effect`. */
	current(app: WhisperingApp): CaptureSurface {
		return isImportSurfaceShowing
			? 'import'
			: (app.local.kv.get('recordingTrigger') ??
					DEVICE_DEFAULTS.recordingTrigger);
	},

	/** Open the file-import overlay over the current trigger. */
	showImport() {
		isImportSurfaceShowing = true;
	},

	/** Close the import overlay, falling back to the durable trigger. Called
	 *  when a trigger is selected and whenever a live capture starts. */
	dismissImport() {
		isImportSurfaceShowing = false;
	},
};
