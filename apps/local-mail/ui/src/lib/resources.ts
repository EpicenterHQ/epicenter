import { createLogger } from 'wellcrafted/logger';
import type { Account } from '@epicenter/auth';
import { openPersonal } from '@epicenter/app/open';
import { openSqlite } from '@epicenter/app/sqlite';
import { openSecrets } from '@epicenter/app/secrets';
import { mailDefinition } from './data.js';
/** Acquire each root once for this browser/WebView lifetime. */
export async function openMailResources(account: Account, signal: AbortSignal) {
    signal.throwIfAborted();
    const personal = await openPersonal(mailDefinition, { account });
    signal.throwIfAborted();
    const sqlite = await openSqlite({ id: mailDefinition.id });
    signal.throwIfAborted();
    const secrets = await openSecrets({ id: mailDefinition.id });
    signal.throwIfAborted();
    const log = createLogger('local-mail/access');
    // Mail continuations use retained SQL and keychain handles. Their access
    // ends at departure even when the browser cannot replace this page.
    signal.addEventListener('abort', () => {
        void sqlite.close().catch((cause) => log.error(cause));
        void secrets.close().catch((cause) => log.error(cause));
    }, { once: true });
    return { personal, sqlite, secrets, signal };
}
