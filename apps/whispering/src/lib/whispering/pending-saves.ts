import { type AnyTaggedError, defineErrors } from 'wellcrafted/error';
import { type Result, tryAsync } from 'wellcrafted/result';

const SaveError = defineErrors({
	Failed: ({ cause }: { cause: unknown }) => ({
		message: 'Saving could not be confirmed.',
		cause,
	}),
});

/** Document-owned Finish saving actions. Reload ends this recovery promise. */
export function createPendingSaves(signal: AbortSignal) {
	const entries = new Set<{
		label: string;
		busy: boolean;
		error: AnyTaggedError | null;
		retry: () => Promise<unknown>;
	}>();
	const listeners = new Set<() => void>();
	function announce() {
		for (const listener of listeners) listener();
	}
	return {
		get entries() {
			return [...entries];
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/** Reserve before producing bytes or inference output; unfinished saves are never evicted. */
		reserve(label: string) {
			signal.throwIfAborted();
			if (entries.size >= 32)
				throw new Error('Finish pending saves before starting more work.');
			const entry = {
				label,
				busy: true,
				error: null as AnyTaggedError | null,
				retry: async (): Promise<unknown> => undefined,
			};
			entries.add(entry);
			announce();
			return {
				discard() {
					entries.delete(entry);
					announce();
				},
				async run<T>(
					save: () => Promise<Result<T, AnyTaggedError>>,
				): Promise<Result<T, AnyTaggedError>> {
					async function attempt(): Promise<Result<T, AnyTaggedError>> {
						entry.busy = true;
						announce();
						const attempted = await tryAsync({
							try: save,
							catch: (cause) => SaveError.Failed({ cause }),
						});
						const result = attempted.error ? attempted : attempted.data;
						entry.busy = false;
						entry.error = result.error;
						if (!result.error) entries.delete(entry);
						announce();
						return result;
					}
					entry.retry = () =>
						entry.busy || signal.aborted ? Promise.resolve() : attempt();
					return attempt();
				},
			};
		},
	};
}
