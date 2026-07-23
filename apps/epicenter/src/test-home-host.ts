import { join } from 'node:path';
import type { AuthFetch } from '@epicenter/auth';
import { type ConversationsTable, chatLens } from '@epicenter/chat';
import {
	createDesktopRecordEpicenterOwner,
	type DesktopRecordNativeCaptureResolver,
} from '@epicenter/data/desktop-record-owner';
import { honeycrispLens } from '@epicenter/honeycrisp';
import { createDesktopAuthAuthority } from './desktop-auth-authority.ts';
import { createHomeHost, type HomeHost, type HomeHostInputs } from './host.ts';

type ConversationsData = { conversations: ConversationsTable };

type OwnedTestHomeHostOptions = HomeHostInputs & {
	/** Fixture root only. Production has no separate Home data directory. */
	dataDir: string;
	recordRoot?: string;
	resolveNativeCapture?: DesktopRecordNativeCaptureResolver;
	wrapConversations?: (data: ConversationsData) => ConversationsData;
};

/** A desktop authority over a no-op native port, for server tests. */
export function createTestDesktopAuth({
	authCell = null,
	fetch,
}: {
	authCell?: string | null;
	fetch?: AuthFetch;
} = {}) {
	const callbackListeners = new Set<(url: string) => void>();
	return createDesktopAuthAuthority({
		authCell,
		...(fetch === undefined ? {} : { fetch }),
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

/** Test composition for the production rule that one owner opens Honeycrisp. */
export async function createOwnedTestHomeHost(
	options: OwnedTestHomeHostOptions,
): Promise<HomeHost> {
	const { host, recordOwner } = await createOwnedTestHomeHostBundle(options);
	return Object.freeze({
		...host,
		async [Symbol.asyncDispose]() {
			await host[Symbol.asyncDispose]();
			await recordOwner[Symbol.asyncDispose]();
		},
	});
}

export async function createOwnedTestHomeHostBundle(
	options: OwnedTestHomeHostOptions,
) {
	const {
		dataDir,
		recordRoot,
		resolveNativeCapture,
		wrapConversations,
		...hostOptions
	} = options;
	const recordOwner = await createDesktopRecordEpicenterOwner({
		directory: recordRoot ?? join(dataDir, 'data'),
		resolveNativeCapture,
	});
	try {
		const home = recordOwner.epicenter.bind({
			chat: chatLens,
			honeycrisp: honeycrispLens,
		});
		const conversations = { conversations: home.chat.conversations };
		const host = await createHomeHost({
			...hostOptions,
			honeycrisp: home.honeycrisp,
			conversations: wrapConversations?.(conversations) ?? conversations,
		});
		return { host, recordOwner };
	} catch (cause) {
		await recordOwner[Symbol.asyncDispose]();
		throw cause;
	}
}
