import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import type { DeliveryOutcome } from '$lib/operations/delivery-reach';
import {
	clipboardSink,
	createCursorSink,
	ledgerSink,
	type Sink,
} from '$lib/operations/sink';
import type { Notice } from '$lib/report';
import type { WhisperingApp } from '$lib/whispering/app';
import { local } from '../whispering/local.js';
import { DEVICE_DEFAULTS } from './settings.js';

// The reach types live in their own `delivery-reach` module next to their ADR
// docstrings; re-exported here so callers keep one delivery import.
export type {
	DeliveryOutcome,
	DeliveryReach,
} from '$lib/operations/delivery-reach';

/**
 * True when any output scope is set to write at the cursor. Cursor delivery is a
 * synthetic Cmd/Ctrl+V, so this is exactly when delivery needs the macOS
 * Accessibility grant, which is the one fact the tap supervisor holds the tap to
 * track. Call inside a reactive scope to stay live as the toggles change.
 */
export function outputWritesToCursor(): boolean {
	return local.kv.get('outputTranscriptionCursor') ?? DEVICE_DEFAULTS.outputTranscriptionCursor;
}

/**
 * Where a transcript originated: a live `recording` or an imported file
 * (`import`). Shapes the success copy and flows in from the pipeline's
 * `deliverySource`.
 */
export type TranscriptionSource = 'recording' | 'import';

const TRANSCRIPTION_SUCCESS_COPY = {
	recording: '📝 Recording transcribed',
	import: '📁 File transcribed',
} as const satisfies Record<TranscriptionSource, string>;

/** A delivery result: the structured outcome plus a human notice for toasts. */
export type DeliveryResult = {
	outcome: DeliveryOutcome;
	notice: Notice;
};

/**
 * Delivers transcript to the user according to their transcription output
 * preferences. Clipboard remains the cursor fallback and optional tee. Returns
 * the structured outcome plus a human notice; it does not toast. The dictation
 * path reads the outcome to drive the pill; file import and row actions show
 * the notice.
 */
export async function deliverTranscriptionResult(
	app: WhisperingApp,
	{
		text,
		source = 'recording',
		showHistoryAction = true,
	}: {
		text: string;
		source?: TranscriptionSource;
		showHistoryAction?: boolean;
	},
): Promise<DeliveryResult> {
	return deliverToSink({
		text,
		successCopy: TRANSCRIPTION_SUCCESS_COPY[source],
		sink: resolveSettingsSink(),
		// A transcription always belongs to a recording, so its history is reachable.
		linkedRecording: showHistoryAction,
	});
}

function resolveSettingsSink(): Sink {
	const cursorRequested =
		local.kv.get('outputTranscriptionCursor') ?? DEVICE_DEFAULTS.outputTranscriptionCursor;
	const clipboardRequested =
		local.kv.get('outputTranscriptionClipboard') ?? DEVICE_DEFAULTS.outputTranscriptionClipboard;

	return cursorRequested
		? createCursorSink({
				keepOnClipboard: clipboardRequested,
				pressEnter: local.kv.get('outputTranscriptionEnter') ?? DEVICE_DEFAULTS.outputTranscriptionEnter,
			})
		: clipboardRequested
			? clipboardSink
			: ledgerSink;
}

async function deliverToSink({
	text,
	successCopy,
	sink,
	linkedRecording,
}: {
	text: string;
	successCopy: string;
	sink: Sink;
	linkedRecording: boolean;
}): Promise<DeliveryResult> {
	const recordingsAction = linkedRecording
		? {
				label: 'Go to recordings',
				onClick: () => goto(resolve('/recordings')),
			}
		: undefined;

	const reach = await sink.deliver(text);

	const title =
		sink.kind === 'cursor'
			? reach === 'output'
				? `${successCopy} and written to cursor!`
				: `${successCopy}, copied to clipboard (couldn't write to cursor)`
			: `${successCopy}!`;

	return {
		outcome: { reach },
		notice: { title, description: text, action: recordingsAction },
	};
}
