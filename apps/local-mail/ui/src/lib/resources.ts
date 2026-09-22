import type { Account } from '@epicenter/auth';
import { openPersonal } from '@epicenter/app/open';
import { openSqlite } from '@epicenter/app/sqlite';
import { openSecrets } from '@epicenter/app/secrets';
import { mailDefinition } from './data.js';
export async function openMailResources(
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
		const personal = await openPersonal(mailDefinition, { account });
		if (personal) {
			handles.push(personal);
			if (signal.aborted) {
				await personal.close();
				signal.throwIfAborted();
			}
		}
		const sqlite = await openSqlite({ id: mailDefinition.id });
		handles.push(sqlite);
		if (signal.aborted) {
			await sqlite.close();
			signal.throwIfAborted();
		}
		const secrets = await openSecrets({ id: mailDefinition.id });
		handles.push(secrets);
		if (signal.aborted) {
			await secrets.close();
			signal.throwIfAborted();
		}
		return {
			personal,
			sqlite,
			secrets,
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
