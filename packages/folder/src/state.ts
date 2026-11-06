/**
 * Where Epicenter's own files live (ADR-0822). A folder holds only its
 * content; what Epicenter keeps is either a hidden file beside its target,
 * under a reserved name, or at the Epicenter folder's root.
 *
 * - A save stages its bytes in `.ep-<random>.save` beside its target, made
 *   with mode 0600, and renames it over the target (`saveName`).
 * - A recording in progress is `.ep-<random>-<name>.recording` beside its
 *   final path `<name>.webm`; only its recorder writes or recovers one.
 * - No listing, watcher, or sync ever describes a reserved name
 *   (`isReservedName`), and a recovery sweep removes stale saves anywhere
 *   in a folder, never a recording nor any other hidden file.
 * - The Epicenter folder keeps the rest in its own `.epicenter/`
 *   (`EPICENTER_STATE`): `synced/<folder-id>.json`, one record per synced
 *   folder, and `hashes/<identity>.json`, a cache whose loss costs only
 *   speed.
 *
 * A folder synced by an older build kept `.epicenter/` inside it
 * (`LEGACY_DIRECTORY`): its manifest `synced.json`, its hash cache
 * `hashes.json`, staged saves in `saves/`, and recordings in progress in
 * `recordings/`. The platform imports the manifest once and removes the rest
 * (`platform/legacy.ts`); nothing writes there now.
 *
 * This module and the folder core's `state.rs` are the two places that
 * spell these names; `fixtures/reserved-names.json` holds both to them, and
 * `bun run check:state-paths` fails when other production code spells
 * `.epicenter`.
 */

/** The Epicenter folder's own directory of records and caches, and an old folder's directory of unfinished writes. */
export const EPICENTER_STATE = '.epicenter';

/** In `EPICENTER_STATE`: one record per synced folder, `synced/<folder-id>.json`. */
export const RECORDS = 'synced';

/** In `EPICENTER_STATE`: each directory's hash cache, `hashes/<identity>.json`. */
export const HASHES = 'hashes';

/** The directory an older build kept inside each folder. */
export const LEGACY_DIRECTORY = EPICENTER_STATE;

/** An old folder's manifest, inside it. */
export const LEGACY_MANIFEST = `${LEGACY_DIRECTORY}/synced.json`;

/** An old folder's hash cache, inside it. */
export const LEGACY_HASHES = `${LEGACY_DIRECTORY}/hashes.json`;

/** An old folder's staged saves, inside it. */
export const LEGACY_SAVES = `${LEGACY_DIRECTORY}/saves`;

/** An old folder's recordings in progress, inside it, at their final paths. */
export const LEGACY_RECORDINGS = `${LEGACY_DIRECTORY}/recordings`;

const PREFIX = '.ep-';
const SAVE = '.save';
const RECORDING = '.recording';

/** A file name Epicenter reserves: `.ep-<something>.save` or `.ep-<something>.recording`. */
const RESERVED = /^\.ep-[^/]+\.(save|recording)$/;

/** Whether the last segment of `path` is a reserved name, which nothing lists. */
export function isReservedName(path: string): boolean {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return RESERVED.test(name);
}

/** Whether the last segment of `path` is a staged save's name. */
export function isSaveName(path: string): boolean {
	return isReservedName(path) && path.endsWith(SAVE);
}

/** Lowercase letters and digits, `length` of them, from the system's random source. */
function random(length: number) {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (const byte of crypto.getRandomValues(new Uint8Array(length)))
		out += alphabet[byte % 36];
	return out;
}

/** A new staged save's name, beside its target: `.ep-<random>.save`. */
export const saveName = () => `${PREFIX}${random(16)}${SAVE}`;

/**
 * A recording in progress's name beside its final path `<name>.webm`:
 * `.ep-<8 random>-<name>.recording`, so a recorder recovering it after a
 * crash knows where it goes.
 */
export const recordingName = (name: string) =>
	`${PREFIX}${random(8)}-${name}${RECORDING}`;

/**
 * The final path of the recording in progress at `pending`
 * (`dir/.ep-<8>-<name>.recording`): `dir/<name>.webm`, or null when it is
 * no recording's name.
 */
export function recordingFinal(pending: string): string | null {
	const slash = pending.lastIndexOf('/');
	const dir = pending.slice(0, slash + 1);
	const name = pending.slice(slash + 1);
	const found = /^\.ep-[0-9a-z]{8}-(.+)\.recording$/.exec(name);
	return found === null ? null : `${dir}${found[1]}.webm`;
}

/** How old a staged save must be before a sweep removes it: its writer stopped. */
export const STALE_SAVE_MS = 60 * 60 * 1000;
