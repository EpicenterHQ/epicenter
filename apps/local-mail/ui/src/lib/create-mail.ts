/** Page-owned mail operations over the app's scoped storage.
 * Mailbox reads include this device's undelivered triage.
 */

import {
	type ConnectedAccount,
	assertAccountLabel,
	discardPending,
	finishConnect,
	listAccounts,
	type MailApp,
	reconcileNow,
	readAccountOutbox,
	removeAccount,
	startConnect,
	withSession,
} from '@epicenter/local-mail/accounts';
import { CALLBACK_PATH } from '@epicenter/local-mail/authorization-return';
import {
	type LabelSummary,
	type MailStatus,
	type MessageDetail,
	type MessageSummary,
	overlayOf,
} from '@epicenter/local-mail/mailbox';
import type { AuthorizationRequest } from '@epicenter/local-mail/oauth';
import {
	type Outbox,
	type PassOutcome,
	readBlockedAccounts,
} from '@epicenter/local-mail/outbox';
import type { GmailAuthorization } from './platform/types.js';

/** Where Google sends a person back to, on this application's own route. */
function redirectUri(): string {
	return new URL(
		CALLBACK_PATH,
		`${window.location.origin}${base()}/`,
	).toString();
}

/** The path this build is served under: `/apps/mail` on the desktop, `/` on the web. */
function base(): string {
	const path = window.location.pathname;
	const marker = '/apps/mail';
	return path.startsWith(marker) ? marker : '';
}

/** The page owns every admitted mail operation until it settles. */
export function createMail({
	openApp,
	authorization,
	closeStorage,
}: {
	openApp: () => Promise<MailApp>;
	authorization: GmailAuthorization;
	closeStorage: () => Promise<void>;
}) {
	let opening: Promise<MailApp> | null = null;
	let closing: Promise<void> | undefined;
	const controller = new AbortController();
	const pending = new Set<Promise<unknown>>();

	function app() {
		return (opening ??= openApp());
	}

	function operation<TArgs extends unknown[], TResult>(
		run: (...args: TArgs) => Promise<TResult>,
	) {
		return (...args: TArgs): Promise<TResult> => {
			if (controller.signal.aborted) {
				return Promise.reject(new Error('Local Mail is closing.'));
			}
			const work = Promise.resolve().then(() => run(...args));
			pending.add(work);
			void work.then(
				() => pending.delete(work),
				() => pending.delete(work),
			);
			return work;
		};
	}

	return {
		/** Stop new work, cancel the consent wait, and finish all admitted writes. */
		close(): Promise<void> {
			controller.abort();
			// Release the physical lifetime even if opening the mail schema failed.
			return (closing ??= Promise.allSettled(pending).then(closeStorage));
		},

		authorize: operation((request: AuthorizationRequest) =>
			authorization.authorize(request, controller.signal),
		),

		accounts: operation(
			async (): Promise<ConnectedAccount[]> => listAccounts(await app()),
		),

		/** Step one of connecting: the URL to visit, and what to hold until we return. */
		beginConnect: operation(
			async (): Promise<AuthorizationRequest> =>
				startConnect(await app(), { redirectUri: redirectUri() }),
		),

		/** Step two: redeem the code Google sent back and record the account. */
		finishConnect: operation(
			async (
				request: AuthorizationRequest,
				callbackUrl: URL,
			): Promise<ConnectedAccount> => {
				const connected = await finishConnect(await app(), {
					request,
					callbackUrl,
				});
				if (connected.error !== null) throw new Error(connected.error.message);
				return connected.data;
			},
		),

		/** Abandon this account's undelivered triage. A thing to mean on purpose. */
		discard: operation(
			async (sub: string): Promise<number> => discardPending(await app(), sub),
		),

		/**
		 * Remove one account from this device.
		 *
		 * Refuses while the account owes Gmail anything, and answers with the count
		 * so a caller can offer the two answers that exist: deliver first, or
		 * discard. Nothing is deleted on the refusal (ADR-0320).
		 */
		remove: operation(
			async (
				sub: string,
			): Promise<{ removed: true } | { removed: false; pending: number }> => {
				const gone = await removeAccount(await app(), sub);
				if (gone.error === null) return { removed: true };
				if (gone.error.name === 'OwesWork') {
					return { removed: false, pending: gone.error.pending };
				}
				throw new Error(gone.error.message);
			},
		),

		/** How much of Gmail this device holds for one account, and how fresh it is. */
		status: operation(
			async (sub: string): Promise<MailStatus> =>
				withSession(await app(), sub, (session) => session.mailbox.status()),
		),

		/**
		 * The outbox: what Gmail has not been told about, and why not.
		 *
		 * Entirely durable, so it answers the same after a reload as before one, and
		 * it says nothing about whether a pass is running: the page knows that from
		 * the pass it is running.
		 */
		outbox: operation(
			async (sub: string): Promise<Outbox> =>
				readAccountOutbox(await app(), sub),
		),

		/**
		 * Which connected accounts cannot move without a person, for the switcher's
		 * mark. The durable file only, so asking about every account does not open
		 * every account's mail file.
		 */
		blocked: operation(
			async (subs: readonly string[]): Promise<Set<string>> =>
				readBlockedAccounts((await app()).storage.local, subs),
		),

		/** This account's mirrored label set, for the rail and for naming a label. */
		labels: operation(
			async (sub: string): Promise<LabelSummary[]> =>
				withSession(await app(), sub, (session) =>
					session.mailbox.listLabels(),
				),
		),

		messages: operation(
			async (
				sub: string,
				query: {
					label?: string;
					search?: string;
					limit?: number;
					offset?: number;
				} = {},
			): Promise<MessageSummary[]> => {
				return withSession(await app(), sub, async (session) =>
					session.mailbox.listMessages({
						labelId: query.label,
						search: query.search,
						limit: query.limit ?? 100,
						offset: query.offset ?? 0,
						overlay: overlayOf(await session.intents.pending()),
					}),
				);
			},
		),

		message: operation(
			async (sub: string, id: string): Promise<MessageDetail | null> => {
				return withSession(await app(), sub, async (session) =>
					session.mailbox.getMessageDetail(
						id,
						overlayOf(await session.intents.pending()),
					),
				);
			},
		),

		/**
		 * Reconcile this account now: deliver what is owed, then pull.
		 *
		 * Resolves when the pass has finished and written what it did, so a caller
		 * can read the outbox straight after and see the result. Asking twice at
		 * once is one pass, not two, and asking repeatedly is safe.
		 */
		reconcile: operation(
			async (sub: string): Promise<PassOutcome> =>
				(await reconcileNow(await app(), sub)).pass,
		),

		/**
		 * Record a triage act. It is durable and visible to the very next read before
		 * this resolves; the reconciler delivers it to Gmail later.
		 */
		assert: operation(
			async (
				sub: string,
				assertion: { messageId: string; labelId: string; want: boolean },
			): Promise<void> => assertAccountLabel(await app(), sub, assertion),
		),
	};
}
