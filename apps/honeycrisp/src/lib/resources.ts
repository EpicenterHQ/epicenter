import type { Account } from '@epicenter/auth';
import { openLocal, openPersonal } from '@epicenter/app/open';
import { honeycrispDefinition } from './data.js';
/** Acquire each root once for this browser/WebView lifetime. */
export async function openHoneycrispResources(account: Account | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    const local = await openLocal(honeycrispDefinition);
    signal.throwIfAborted();
    const personal = account ? await openPersonal(honeycrispDefinition, { account }) : undefined;
    signal.throwIfAborted();
    return { local, personal, signal };
}
