/**
 * The captures this UI shows: the newest `limit` by capturedAt, from the
 * app's `recent` action, narrowed by a search the server runs over every
 * file. One object for the page, made once, so going to a capture and back
 * keeps what was shown.
 *
 * Nothing is kept on the device. `refresh` asks again; the list page calls
 * it on a timer and when the page becomes visible. A refresh that started
 * before a write finished is dropped, so an answer never undoes a write the
 * person just made.
 */
import { connect } from '@epicenter/app/client';
import { toast } from '@epicenter/ui/sonner';
import type { Recent } from '../../../epicenter.js';

/** The app's actions, asked of `epicenter serve`. */
export const capture = connect('capture');

/** One capture as listed; `pending` while its `add` has not answered. */
export type Row = Recent['captures'][number] & { pending?: true };

const PAGE = 50;

/** What a failed call says, for a toast. */
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createCaptures() {
	let rows = $state.raw<Row[]>([]);
	let total = $state(0);
	let limit = $state(PAGE);
	/** The search typed, trimmed. */
	let matching = $state('');
	/** The search `rows` answer, once any answer has come. */
	let answered = $state<string>();
	let problem = $state<string>();
	let adding = $state.raw<Row[]>([]);

	/** Bumped as each write starts and ends; an answer asked under an older one is stale. */
	let writes = 0;
	let inFlight = 0;
	let asked = 0;
	let nextPending = 0;

	async function refresh() {
		const request = ++asked;
		const before = writes;
		const query = matching;
		try {
			const answer = await capture.call<Recent>('recent', {
				limit,
				...(query ? { matching: query } : {}),
			});
			if (request !== asked || before !== writes || inFlight > 0) return;
			rows = answer.captures;
			total = answer.total;
			answered = query;
			problem = undefined;
		} catch (error) {
			if (request === asked) problem = messageOf(error);
		}
	}

	/** Runs `write`, holding back refreshes until it lands, then refreshes. */
	async function writing<T>(write: () => Promise<T>): Promise<T> {
		writes++;
		inFlight++;
		try {
			return await write();
		} finally {
			writes++;
			inFlight--;
			void refresh();
		}
	}

	return {
		/** What to list: captures being added, then the newest, narrowed here by the search until the server answers it. */
		rows() {
			const listed =
				answered === matching
					? rows
					: rows.filter((row) =>
							row.text.toLowerCase().includes(matching.toLowerCase()),
						);
			return [...adding, ...listed];
		},
		/** Whether the first answer has come. */
		isLoaded() {
			return answered !== undefined;
		},
		/** How many captures there are beyond those listed, for the current search. */
		more() {
			return answered === matching ? Math.max(0, total - rows.length) : 0;
		},
		/** Why the last refresh failed, until one succeeds. */
		problem() {
			return problem;
		},
		/** The search, trimmed. */
		matching() {
			return matching;
		},
		refresh,
		search(text: string) {
			if (text.trim() === matching) return;
			matching = text.trim();
			limit = PAGE;
			void refresh();
		},
		showMore() {
			limit += PAGE;
			void refresh();
		},
		/**
		 * Adds `text` as a capture, listed at once. Resolves false, after a
		 * toast saying why, when it was not written.
		 */
		async add(text: string): Promise<boolean> {
			const shown: Row = {
				id: `pending-${++nextPending}`,
				capturedAt: new Date().toISOString(),
				text: text.trim(),
				thoughts: 0,
				pending: true,
			};
			adding = [shown, ...adding];
			try {
				const { id, capturedAt } = await writing(() =>
					capture.call<{ id: string; capturedAt: string }>('add', { text }),
				);
				rows = [
					{ id, capturedAt, text: shown.text, thoughts: 0 },
					...rows.filter((row) => row.id !== id),
				];
				total += 1;
				return true;
			} catch (error) {
				toast.error('Not captured', { description: messageOf(error) });
				return false;
			} finally {
				adding = adding.filter((row) => row !== shown);
			}
		},
		/** Deletes the capture `id`; throws when the server did not. */
		async delete(id: string) {
			await writing(() => capture.call('delete', { id }));
			if (rows.some((row) => row.id === id)) total -= 1;
			rows = rows.filter((row) => row.id !== id);
		},
		/** Shows a capture's new text and thought count after its page saved it. */
		saved(id: string, text: string, thoughts: number) {
			rows = rows.map((row) =>
				row.id === id ? { ...row, text, thoughts } : row,
			);
			writes++;
		},
	};
}

export const captures = createCaptures();
