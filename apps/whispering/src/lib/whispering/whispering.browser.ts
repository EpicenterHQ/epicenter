/**
 * Browser runtime client for Whispering. Consumed everywhere through the
 * `#platform/whispering` seam; see `whispering.active.ts` for what
 * `openWhisperingBrowser` builds. The web default transcription service is
 * OpenAI.
 */

import { auth } from '#platform/auth';
import { openWhisperingBrowser } from './whispering.active';

export const whispering = openWhisperingBrowser({
	auth,
	defaultTranscriptionService: 'OpenAI',
});
