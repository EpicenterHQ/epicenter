import { openEpicenterInference } from '@epicenter/app/ai';
import { openAccountConnectionCatalog } from '@epicenter/app/ai-connections';
import { openLocal, openPersonal } from '@epicenter/app/open';
import type { Account } from '@epicenter/auth';
import { extractErrorMessage } from 'wellcrafted/error';
import { chatHistoryDefinition, vocabDefinition } from './data.js';
export async function openVocabResources(
	account: Account,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	const local = await openLocal(chatHistoryDefinition);
	signal.throwIfAborted();
	const personal = await openPersonal(vocabDefinition, { account });
	signal.throwIfAborted();
	const inference = Promise.allSettled([
		openEpicenterInference({ account }),
		openAccountConnectionCatalog({ account }),
	]).then(([hosted, connections]) => ({
		account: hosted.status === 'fulfilled' ? hosted.value : null,
		runtime: null,
		connections: connections.status === 'fulfilled' ? connections.value : null,
		errors: [hosted, connections].flatMap((result) =>
			result.status === 'rejected' ? [extractErrorMessage(result.reason)] : [],
		),
	}));
	return { local, personal, inference, account, signal };
}
