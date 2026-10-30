/**
 * Whether a recording's audio is in this device's folder.
 *
 * Recordings resolve one supported audio file beside the Markdown file
 * with the same stem. Multiple matches need repair instead of an arbitrary
 * extension preference.
 */
import { audioMimeTypeOf } from './audio-format.js';
import { recordingAudioStem } from './definition.js';
import type { Listing } from './files.js';

export type RecordingAudio =
	/** The listing has not established an audio path yet. */
	| { readonly kind: 'none' }
	/** The audio is in the folder, or may be: nothing says it is missing. */
	| { readonly kind: 'here'; readonly path: string }
	/** The folder listing does not hold the audio the row names. */
	| { readonly kind: 'absent'; readonly path: string }
	/** More than one supported audio file shares the recording's stem. */
	| { readonly kind: 'ambiguous'; readonly paths: readonly string[] };

/**
 * Where a recording's audio is. `listing` is the folder's last file
 * listing, undefined before one is read. `settling` is whether this window is
 * still capturing the recording or writing its row, when its audio may be on
 * disk before a listing shows it. Neither an unread listing nor a settling
 * recording is reported absent: only a listing read once the recording
 * finished can say the audio is not here.
 */
export function recordingAudio(
	stem: string,
	{
		listing,
		settling,
		capturePath,
	}: {
		listing: Pick<Listing, 'byStem'> | undefined;
		settling: boolean;
		capturePath?: string;
	},
): RecordingAudio {
	if (settling && capturePath !== undefined)
		return { kind: 'here', path: capturePath };
	if (listing === undefined) return { kind: 'none' };
	const base = recordingAudioStem(stem);
	const paths = (listing.byStem.get(base) ?? [])
		.filter((path) => audioMimeTypeOf(path) !== undefined)
		.sort();
	if (paths.length > 1) return { kind: 'ambiguous', paths };
	if (paths[0] !== undefined) return { kind: 'here', path: paths[0] };
	if (settling) return { kind: 'none' };
	return { kind: 'absent', path: `${base}.*` };
}
