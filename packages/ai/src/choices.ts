/**
 * `@epicenter/ai/choices`: the person's model choice for each job, as a
 * device setting. A job is a key an app names (`'chat'`, `'transcribe'`, or
 * its own), and its choice names an endpoint and a model there
 * (`ModelChoice`). A choice whose endpoint is gone stays saved and is still
 * answered, so a caller checks it against `ai.models()` and nothing falls
 * back to another endpoint.
 *
 * Where choices are kept is the build's: `modelChoices()` from
 * `@epicenter/ai` keeps them in this browser's storage on the web and in
 * `models.md` in the app's AppData root on the desktop, beside the
 * connections they name. `createModelChoices` makes the same value over any
 * place, as a test does over memory.
 */
import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type { ModelChoice } from './open-ai.js';

const log = createLogger('ai/choices');

/** The choices a place holds: one per job. */
export type SavedChoices = Readonly<Record<string, ModelChoice>>;

/** Where choices are kept. */
export type ChoicesPlace = {
	/** Every choice saved now. */
	read(): Promise<SavedChoices>;
	/** Save `choice` for `job` over what is saved now, and answer every choice saved then. */
	save(job: string, choice: ModelChoice): Promise<SavedChoices>;
	/** Call `listener` when another window or program changed what is saved. */
	watch?(listener: () => void): () => void;
};

/** The person's model choice for each job, on this device. */
export type ModelChoices<TJob extends string = string> = {
	/** The choice saved for `job`, else the app's default for it, else null. */
	get(job: TJob): ModelChoice | null;
	/** Save `choice` for `job`. Rejects, and changes nothing, when it cannot be saved. */
	set(job: TJob, choice: ModelChoice): Promise<void>;
	/** Call `listener` when a choice may have changed; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
	/** Settles once the saved choices were read, or could not be. */
	readonly ready: Promise<void>;
	/** Why the saved choices could not be read, or null. While it is set, only defaults answer. */
	problem(): string | null;
	[Symbol.dispose](): void;
};

function invalid(): never {
	throw new Error('Invalid persisted model choices.');
}

/** One choice as saved: exactly an endpoint and a model. */
function choiceOf(value: unknown): ModelChoice {
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
	const entry = value as Record<string, unknown>;
	if (
		Object.keys(entry).some((key) => !['endpoint', 'model'].includes(key)) ||
		typeof entry.endpoint !== 'string' ||
		typeof entry.model !== 'string'
	)
		invalid();
	return { endpoint: entry.endpoint, model: entry.model };
}

/** Validate saved choices, keeping a choice whose endpoint is gone. */
export function validateModelChoices(value: unknown): SavedChoices {
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
	return Object.fromEntries(
		Object.entries(value).map(([job, choice]) => [job, choiceOf(choice)]),
	);
}

/** The choices for each job over `place`, with the app's `defaults` for a job none was saved for. */
export function createModelChoices<TJob extends string = string>(
	place: ChoicesPlace,
	defaults: Partial<Record<TJob, ModelChoice>> = {},
): ModelChoices<TJob> {
	let saved: SavedChoices = {};
	let problem: string | null = null;
	let disposed = false;
	let writes: Promise<unknown> = Promise.resolve();
	const listeners = new Set<() => void>();

	function assertOpen() {
		if (disposed) throw new Error('Model choices are disposed.');
	}
	function notify() {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch (cause) {
				log.error(new Error('A model choices subscriber failed.', { cause }));
			}
		}
	}
	function adopt(next: SavedChoices) {
		if (JSON.stringify(next) === JSON.stringify(saved) && problem === null)
			return;
		saved = next;
		problem = null;
		notify();
	}
	async function reread() {
		try {
			const next = await place.read();
			if (!disposed) adopt(next);
		} catch (cause) {
			if (disposed) return;
			problem = extractErrorMessage(cause);
			notify();
		}
	}

	const ready = reread();
	const unwatch = place.watch?.(() => {
		if (!disposed) void reread();
	});

	return {
		get(job) {
			assertOpen();
			const choice = Object.hasOwn(saved, job)
				? saved[job]
				: Object.hasOwn(defaults, job)
					? defaults[job]
					: undefined;
			return choice ? { ...choice } : null;
		},
		set(job, choice) {
			assertOpen();
			const exact = choiceOf(choice);
			const write = writes.then(async () => {
				const next = await place.save(job, exact);
				if (!disposed) adopt(next);
			});
			writes = write.catch(() => {});
			return write;
		},
		subscribe(listener) {
			assertOpen();
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		ready,
		problem: () => problem,
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			listeners.clear();
			unwatch?.();
		},
	};
}
