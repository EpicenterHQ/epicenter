import { type AnyTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { Ok, type Result, trySync } from 'wellcrafted/result';
import type { WhisperingApp, WhisperingData } from '../whispering/app.js';
import { polishWillRun, runPolish } from './run-polish.js';
import { saveCleanedTranscription } from './transcription-history.js';

/** Reserve recoverable space before asking a completion model for Cleaned text. */
export function prepareCleanup(
	app: WhisperingApp,
	store: WhisperingData,
	{ text, resultId }: { text: string; resultId: string | null },
) {
	const enabled = resultId !== null && polishWillRun(app, text);
	const reserved = enabled
		? trySync({
				try: () => app.pendingSaves.reserve('Cleaned transcript'),
				catch: (cause) => ({
					data: null,
					error: {
						name: 'Capacity',
						message: extractErrorMessage(cause),
					},
				}),
			})
		: null;
	const willRun = enabled && reserved?.error === null;
	return {
		willRun,
		capacityError: reserved?.error ?? null,
		async run(signal?: AbortSignal): Promise<{
			text: string;
			history: Result<void, AnyTaggedError>;
			cleanupError: AnyTaggedError | null;
		}> {
			if (!willRun || !reserved?.data || resultId === null)
				return { text, history: Ok(undefined), cleanupError: null };
			let cleaned: Awaited<ReturnType<typeof runPolish>>;
			try {
				cleaned = await runPolish(app, { input: text, signal });
			} catch (cause) {
				reserved.data.discard();
				throw cause;
			}
			if (app.signal.aborted) {
				reserved.data.discard();
				return { text, history: Ok(undefined), cleanupError: null };
			}
			if (cleaned.error) {
				reserved.data.discard();
				return {
					text: cleaned.error.fallback,
					history: Ok(undefined),
					cleanupError: cleaned.error,
				};
			}
			if (cleaned.data === text || app.signal.aborted) {
				reserved.data.discard();
				return { text, history: Ok(undefined), cleanupError: null };
			}
			const history = await saveCleanedTranscription(
				app,
				store,
				resultId,
				{ rawText: text, cleanedText: null },
				cleaned.data,
				reserved.data,
			);
			return { text: cleaned.data, history, cleanupError: null };
		},
	};
}
