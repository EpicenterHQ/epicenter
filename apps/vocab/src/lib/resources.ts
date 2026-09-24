import { extractErrorMessage } from 'wellcrafted/error';
import type { Account } from '@epicenter/auth';
import { openLocal, openPersonal } from '@epicenter/app/open';
import {
	openEpicenterInference,
	openRuntimeTranscriber,
} from '@epicenter/app/ai';
import { openAccountConnectionCatalog } from '@epicenter/app/ai-connections';
import { chatHistoryDefinition, vocabDefinition } from './data.js';
export async function openVocabResources(account: Account, signal: AbortSignal) {
    signal.throwIfAborted();
    const local = await openLocal(chatHistoryDefinition);
    signal.throwIfAborted();
    const personal = await openPersonal(vocabDefinition, { account });
    signal.throwIfAborted();
    const inference = Promise.allSettled([
        openEpicenterInference({ account }),
        openRuntimeTranscriber(),
        openAccountConnectionCatalog({ account }),
    ]).then(([hosted, runtime, connections]) => ({
        account: hosted.status === 'fulfilled' ? hosted.value : null,
        runtime: runtime.status === 'fulfilled' ? runtime.value : null,
        connections: connections.status === 'fulfilled' ? connections.value : null,
        errors: [hosted, runtime, connections].flatMap((result) => result.status === 'rejected' ? [extractErrorMessage(result.reason)] : []),
    }));
    return { local, personal, inference, account, signal };
}
