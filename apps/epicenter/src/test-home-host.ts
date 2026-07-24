import { join } from 'node:path';
import { openBunEpicenter } from '@epicenter/data/runtime/bun';
import { honeycrispLens } from '@epicenter/honeycrisp';
import { createDesktopAuthAuthority } from './desktop-auth-authority.ts';
import { createHomeHost, type HomeHost, type HomeHostInputs } from './host.ts';
import type { ConversationsData } from './workspace.ts';
import { homeLens } from './workspace.ts';

type OwnedTestHomeHostOptions = HomeHostInputs & {
	/** Fixture root only. Production has no separate Home data directory. */
	dataDir: string;
	wrapConversations?: (workspace: ConversationsData) => ConversationsData;
};

/** A signed-out desktop authority over a no-op native port, for server tests. */
export function createTestDesktopAuth() {
	const callbackListeners = new Set<(url: string) => void>();
	return createDesktopAuthAuthority({
		authCell: null,
		nativeAuthPort: {
			completed: new Promise(() => undefined),
			async storeAuth() {},
			async openAuthUrl() {},
			relaunch() {},
			onOAuthCallback(listener) {
				callbackListeners.add(listener);
				return () => callbackListeners.delete(listener);
			},
		},
	});
}

/** Test composition for the production rule that one runtime binds both lenses. */
export async function createOwnedTestHomeHost(
	options: OwnedTestHomeHostOptions,
): Promise<HomeHost> {
	const { dataDir, wrapConversations, ...hostOptions } = options;
	const runtime = await openBunEpicenter({
		directory: join(dataDir, 'data'),
		owner: null,
	});
	try {
		const home = runtime.bind(homeLens);
		const honeycrisp = runtime.bind(honeycrispLens);
		const conversations = { conversations: home.conversations };
		const host = await createHomeHost({
			...hostOptions,
			honeycrisp: {
				folders: honeycrisp.folders,
				notes: honeycrisp.notes,
			},
			conversations: wrapConversations?.(conversations) ?? conversations,
		});
		return Object.freeze({
			...host,
			async [Symbol.asyncDispose]() {
				await host[Symbol.asyncDispose]();
				await runtime[Symbol.asyncDispose]();
			},
		});
	} catch (cause) {
		await runtime[Symbol.asyncDispose]();
		throw cause;
	}
}
