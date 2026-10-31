import { openEpicenterInference } from '@epicenter/ai';
import type { InferenceSources } from '@epicenter/ai/target';
import type { Account } from '@epicenter/auth';
import { extractErrorMessage } from 'wellcrafted/error';
import { openConnections } from '#platform/connections';

/**
 * Where the tutor can run. The endpoints a learner connected are saved for
 * this device, not for an account, so the same ones are there signed out and
 * signed in (`#platform/connections`: this browser's storage on the web; on
 * the desktop the AppData root's `connections.md`, with each key in the
 * keychain and every request sent by the shell). Signing in only adds Epicenter's hosted models beside them,
 * whose requests the desktop's shell sends for the page (`account.fetch`).
 * Neither decides where the words and chats are: a failure here leaves words and
 * chats usable and is reported in the model picker.
 */
export async function openVocabInference(
	account: Account | undefined,
	open: {
		hosted: (options: {
			account: Account;
		}) => Promise<NonNullable<InferenceSources['account']>>;
		connections: () => Promise<NonNullable<InferenceSources['connections']>>;
	} = {
		hosted: openEpicenterInference,
		connections: openConnections,
	},
): Promise<InferenceSources> {
	const [hosted, connections] = await Promise.allSettled([
		account ? open.hosted({ account }) : null,
		open.connections(),
	]);
	return {
		account: hosted.status === 'fulfilled' ? hosted.value : null,
		connections: connections.status === 'fulfilled' ? connections.value : null,
		errors: [hosted, connections].flatMap((result) =>
			result.status === 'rejected' ? [extractErrorMessage(result.reason)] : [],
		),
	};
}
