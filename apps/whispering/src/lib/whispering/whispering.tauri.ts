/**
 * Tauri runtime client for Whispering. Consumed everywhere through the
 * `#platform/whispering` seam; see `whispering.active.ts` for what
 * `openWhisperingBrowser` builds. The desktop default transcription service is
 * the on-device local GGUF provider.
 */

import { auth } from '#platform/auth';
import { openWhisperingBrowser } from './whispering.active';

export const whispering = openWhisperingBrowser({
	auth,
	defaultTranscriptionService: 'local',
});
