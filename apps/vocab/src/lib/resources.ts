import type { Account } from '@epicenter/auth';
import { openLocal, openPersonal } from '@epicenter/app/open';
import {
	openEpicenterInference,
	openRuntimeInference,
} from '@epicenter/app/ai';
import { openAccountConnectionCatalog } from '@epicenter/app/ai-connections';
import { vocabDefinition } from './data.js';
export async function openVocabResources(
	account: Account,
	signal: AbortSignal = new AbortController().signal,
) {
	const handles: Array<{ signal: AbortSignal; close(): Promise<void> }> = [];
	const lifetime = new AbortController();
	let closing: Promise<void> | undefined;
	function close(): Promise<void> {
		if (closing) return closing;
		const completion = Promise.withResolvers<void>();
		closing = completion.promise;
		signal.removeEventListener('abort', cancelStartup);
		lifetime.abort();
		void Promise.allSettled(handles.map(async (handle) => handle.close())).then(
			(results) => {
				const failures = results.flatMap((result) =>
					result.status === 'rejected' ? [result.reason] : [],
				);
				if (failures.length)
					completion.reject(
						new AggregateError(failures, 'Product cleanup failed.'),
					);
				else completion.resolve();
			},
		);
		return closing;
	}
	const cancelStartup = () => {
		void close().catch(() => {});
	};
	signal.throwIfAborted();
	signal.addEventListener('abort', cancelStartup, { once: true });
	try {
		const local = await openLocal(vocabDefinition);
		handles.push(local);
		if (signal.aborted) {
			await local.close();
			signal.throwIfAborted();
		}
		const personal = await openPersonal(vocabDefinition, { account });
		if (personal) {
			handles.push(personal);
			if (signal.aborted) {
				await personal.close();
				signal.throwIfAborted();
			}
		}
		const epicenterInference = await openEpicenterInference({ account });
		if (epicenterInference) {
			handles.push(epicenterInference);
			if (signal.aborted) {
				await epicenterInference.close();
				signal.throwIfAborted();
			}
		}
		const runtimeInference = await openRuntimeInference();
		if (runtimeInference) {
			handles.push(runtimeInference);
			if (signal.aborted) {
				await runtimeInference.close();
				signal.throwIfAborted();
			}
		}
		signal.throwIfAborted();
		const connections = await openAccountConnectionCatalog({ account });
		handles.push(connections);
		if (signal.aborted) {
			await connections.close();
			signal.throwIfAborted();
		}
		return {
			local,
			personal,
			epicenterInference,
			runtimeInference,
			connections,
			signal: AbortSignal.any([
				lifetime.signal,
				...handles.map((handle) => handle.signal),
			]),
			close,
		};
	} catch (cause) {
		try {
			await close();
		} catch (cleanup) {
			throw new AggregateError(
				[cause, cleanup],
				'Product opening and cleanup failed.',
				{ cause },
			);
		}
		throw cause;
	}
}
