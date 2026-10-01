import { openPersonal } from '@epicenter/app/open';
import { openSecrets } from '@epicenter/app/secrets';
import type { Account } from '@epicenter/auth';
import { createLogger } from 'wellcrafted/logger';
import { mailDefinition } from './data.js';

/** Acquire each root once; departure fences mail access even if navigation stalls. */
export async function openMailResources(account: Account, signal: AbortSignal) {
	signal.throwIfAborted();
	const personal = await openPersonal(mailDefinition, { account });
	let secrets: Awaited<ReturnType<typeof openSecrets>> | undefined;
	const log = createLogger('local-mail/access');
	function retire() {
		void personal.close().catch((cause) => log.error(cause));
		void secrets?.close().catch((cause) => log.error(cause));
	}
	signal.addEventListener('abort', retire, { once: true });
	try {
		signal.throwIfAborted();
		secrets = await openSecrets({ id: mailDefinition.id });
		signal.throwIfAborted();
		return { personal, sqlite: personal.sqlite, secrets, signal };
	} catch (cause) {
		signal.removeEventListener('abort', retire);
		const cleanup = await Promise.allSettled([
			personal.close(),
			secrets?.close(),
		]);
		const failures = cleanup
			.filter((result) => result.status === 'rejected')
			.map((result) => result.reason);
		if (failures.length)
			throw new AggregateError(
				[cause, ...failures],
				'Local Mail opening and cleanup failed.',
				{ cause },
			);
		throw cause;
	}
}
