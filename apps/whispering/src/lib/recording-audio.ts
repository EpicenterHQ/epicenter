/**
 * Whether a recording's audio is in this device's folder.
 *
 * A row's `audioPath` can name a file the folder does not hold: the
 * recording may have been made on another device, its capture may have
 * failed, or its file may have been deleted here. Nothing that needs the
 * audio (playing it, transcribing it) can run. A missing file is told apart
 * from a row that names no audio at all, which the person repairs in its
 * Source.
 */
import { audioPathIn, type RecordingFields } from './definition.js';
import type { Listing } from './files.js';

export type RecordingAudio =
	/** The row names no audio. */
	| { readonly kind: 'none' }
	/** The audio is in the folder, or may be: nothing says it is missing. */
	| { readonly kind: 'here'; readonly path: string }
	/** The folder listing does not hold the audio the row names. */
	| { readonly kind: 'absent'; readonly path: string };

/**
 * Where the audio `fields` names is. `listing` is the folder's last file
 * listing, undefined before one is read. `settling` is whether this window is
 * still capturing the recording or writing its row, when its audio may be on
 * disk before a listing shows it. Neither an unread listing nor a settling
 * recording is reported absent: only a listing read once the recording
 * settled can say the audio is not here.
 */
export function recordingAudio(
	fields: Readonly<Partial<RecordingFields>>,
	{
		listing,
		settling,
	}: { listing: Pick<Listing, 'paths'> | undefined; settling: boolean },
): RecordingAudio {
	const path = audioPathIn(fields);
	if (path === undefined) return { kind: 'none' };
	if (settling || listing === undefined || listing.paths.has(path))
		return { kind: 'here', path };
	return { kind: 'absent', path };
}
