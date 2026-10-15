/**
 * The departure wire between the native host and the Capture and Todos pages.
 *
 * Quitting Epicenter, or restarting it for an account change, ends every page
 * the host serves. Rust (`src-tauri/src/departure.rs`) runs one round and asks
 * both windows; a page owns its drafts and answers for them. This module is the
 * published shape of that wire, imported as `@epicenter/epicenter/departure`.
 * It holds no runtime but a strict reader. The one page client over it is
 * `./departure-page.svelte.ts` (`@epicenter/epicenter/departure/page`), bound
 * to the Tauri window by `./departure-window.ts`; each app keeps its own owner
 * behind the client's participant and its own words.
 *
 *   event   departure-changed   targeted at the window's label, no payload
 *   invoke  departure_status    () -> DepartureStatus
 *   invoke  departure_answer    { generation, round, answer } -> DepartureStatus
 *   event   host-stopped        targeted, no payload: the Bun host that served
 *                               this page stopped; the page and its open
 *                               folder keep working, its HTTP session does not
 *                               come back
 *
 * Rust identifies the caller by the window the call came from. A stale
 * `generation` or `round` changes nothing and returns the current status, so a
 * page never parses an error to learn it was late. Every native change raises
 * `version`.
 *
 * Page rules, in order:
 *
 * 1. Await listener registration first, with
 *    `getCurrentWebviewWindow().listen(DEPARTURE_CHANGED_EVENT, ...)`. A global
 *    `listen` registers for any target and can hear the other window's nudge;
 *    that is harmless, because a nudge only means "read again", but it is noise.
 * 2. Then read `departure_status`. Only an `idle` read lets the page become
 *    editable. A page still opening its owner buffers what it reads; a page
 *    that failed to open, or never opened, has nothing to settle and answers
 *    `ready`, but stays fenced against retries.
 * 3. On every nudge, and whenever the window gains focus while fenced, read
 *    again. Ignore a status whose `version` is lower than the highest applied.
 * 4. A `collecting` round the page has not handled: fence input and actions
 *    before any await. A page holding nothing unsaved answers `ready` at once.
 *    Otherwise it answers `asking`, which shows its window even if the person
 *    had closed it, flushes the chosen complete draft, and subscribes before
 *    draining accepted native writes. Then it answers `ready`, or asks the
 *    person: "Keep working" answers `cancel`; a deliberate discard answers
 *    `ready`. Approval never closes, discards, or reloads the page.
 * 5. The same round again with `vote: 'none'` means the person asked again,
 *    by quitting during a quit or a restart round; the intent does not change.
 *    While handling, re-send `asking` without opening a second prompt. Once
 *    decided, re-send that same `ready` or `cancel` if the recorded vote still
 *    lags it, including `asking` after a lost `ready`. A repeated Quit keeps
 *    the round and its choice; only a new round permits a new choice. A page
 *    that stays silent reaches the native dialog, whose default keeps open.
 * 6. Thaw only on an authoritative `idle` newer than the page's own answer.
 *    A newer round is handled while still fenced. `granted`, `leaving`, and a
 *    `discarded` vote stay fenced. A lost or rejected answer never thaws.
 *
 * A round that ends without leaving puts every window it showed or hid back
 * as it found it, shown or hidden. While a round runs, a participant window
 * cannot be created; a discarded or granted one cannot be shown by any native
 * path, the macOS Window menu included.
 */

export const DEPARTURE_CHANGED_EVENT = 'departure-changed';
export const HOST_STOPPED_EVENT = 'host-stopped';
export const DEPARTURE_STATUS_COMMAND = 'departure_status';
export const DEPARTURE_ANSWER_COMMAND = 'departure_answer';

export type DepartureIntent = 'quit' | 'restart';
/**
 * `none`: not answered, or asked again by a repeated Quit. `discarded`: a
 * person discarded this page in the native dialog; its window is hidden until
 * the round ends.
 */
export type DepartureVote = 'none' | 'asking' | 'ready' | 'discarded';
export type DepartureAnswer = 'asking' | 'ready' | 'cancel';

export type DepartureStatus =
	| { version: number; generation: number; phase: 'idle' }
	| {
			version: number;
			generation: number;
			phase: 'collecting' | 'granted' | 'leaving';
			round: number;
			intent: DepartureIntent;
			vote: DepartureVote;
	  };

export type DepartureAnswerArgs = {
	generation: number;
	round: number;
	answer: DepartureAnswer;
};

const ROUND_PHASES = ['collecting', 'granted', 'leaving'];
const INTENTS = ['quit', 'restart'];
const VOTES = ['none', 'asking', 'ready', 'discarded'];

/** Read one status exactly, or throw. */
export function parseDepartureStatus(value: unknown): DepartureStatus {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new Error('A departure status must be an object.');
	const status = value as Record<string, unknown>;
	const keys = Object.keys(status).sort().join(',');
	const isCount = (field: unknown) =>
		typeof field === 'number' && Number.isSafeInteger(field) && field >= 0;
	if (!isCount(status.version) || !isCount(status.generation))
		throw new Error('A departure status needs a version and a generation.');
	if (status.phase === 'idle') {
		if (keys !== 'generation,phase,version')
			throw new Error('An idle departure status has no round.');
		return status as DepartureStatus;
	}
	if (
		!ROUND_PHASES.includes(status.phase as string) ||
		keys !== 'generation,intent,phase,round,version,vote' ||
		!isCount(status.round) ||
		!INTENTS.includes(status.intent as string) ||
		!VOTES.includes(status.vote as string)
	)
		throw new Error('A departure round status is malformed.');
	return status as DepartureStatus;
}
