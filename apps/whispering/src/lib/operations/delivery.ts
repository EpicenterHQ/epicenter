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

// The reach types live in their own `delivery-reach` module next to their ADR
// docstrings; re-exported here so callers keep one delivery import.
export type {
	DeliveryOutcome,
	DeliveryReach,
} from '$lib/operations/delivery-reach';

/**
 * The output scopes Whispering delivers into. Each has its own
 * clipboard/cursor/enter toggles under `settings.output.<scope>.*`. Keeping the list in
 * one place lets delivery and the auto-paste intent derive from the same source
 * instead of hardcoding the scope names.
 */
const OUTPUT_SCOPES = ['transcription', 'recipe'] as const;
type OutputScope = (typeof OUTPUT_SCOPES)[number];

/**
 * Where each scope's three delivery toggles live, as the workspace kv keys
 * that hold them. Written out rather than composed from the scope name: a
 * durable key is not something to compute from an identifier a rename could
 * change.
 */
const OUTPUT_KEYS = {
	transcription: {
		cursor: 'outputTranscriptionCursor',
		clipboard: 'outputTranscriptionClipboard',
		enter: 'outputTranscriptionEnter',
	},
	recipe: {
		cursor: 'outputRecipeCursor',
		clipboard: 'outputRecipeClipboard',
		enter: 'outputRecipeEnter',
	},
} as const;

/**
 * True when any output scope is set to write at the cursor. Cursor delivery is a
 * synthetic Cmd/Ctrl+V, so this is exactly when delivery needs the macOS
 * Accessibility grant, which is the one fact the tap supervisor holds the tap to
 * track. Call inside a reactive scope to stay live as the toggles change.
 */
export function outputWritesToCursor(app: WhisperingApp): boolean {
	return OUTPUT_SCOPES.some((scope) =>
		app.settings.get(OUTPUT_KEYS[scope].cursor),
	);
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
	}: {
		text: string;
		source?: TranscriptionSource;
	},
): Promise<DeliveryResult> {
	return deliverToSink({
		text,
		successCopy: TRANSCRIPTION_SUCCESS_COPY[source],
		sink: resolveSettingsSink(app, 'transcription'),
		// A transcription always belongs to a recording, so its history is reachable.
		linkedRecording: true,
	});
}

/**
 * Delivers a Recipe's output to the user according to their text output
 * preferences. Returns the structured outcome plus a human notice. `recordingId`
 * is the run's link to a recording, or null for ad-hoc runs (clipboard,
 * selection): only a recording-anchored run offers a "go to recordings" action,
 * since an ad-hoc run has no history to open.
 */
export async function deliverRecipeResult(
	app: WhisperingApp,
	{
		text,
		recordingId,
	}: {
		text: string;
		recordingId: string | null;
	},
): Promise<DeliveryResult> {
	return deliverToSink({
		text,
		successCopy: '🔄 Recipe complete',
		sink: resolveSettingsSink(app, 'recipe'),
		linkedRecording: recordingId !== null,
	});
}

function resolveSettingsSink(
	app: WhisperingApp,
	settingsScope: OutputScope,
): Sink {
	const keys = OUTPUT_KEYS[settingsScope];
	const cursorRequested = app.settings.get(keys.cursor);
	const clipboardRequested = app.settings.get(keys.clipboard);

	return cursorRequested
		? createCursorSink({
				keepOnClipboard: clipboardRequested,
				pressEnter: app.settings.get(keys.enter),
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
