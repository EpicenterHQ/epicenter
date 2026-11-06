/**
 * Messages on this computer: Beeper's device connection, and the one place
 * the local program (`apps/messages/scripts/serve.ts`) and
 * `epicenter messages --json` open Messages' folder, send journal and send
 * owner (`openMessages`). No message history or token is written to a
 * folder.
 */
import { join } from 'node:path';
import BeeperDesktop from '@beeper/desktop-api';
import { openDevice } from '@epicenter/folder/node';
import { Check } from 'typebox/value';
import { resolveAppPaths } from './app-paths.js';
import { messagesContract } from './messages-contract.js';
import { openSendJournal } from './messages-journal.js';
import { type Beeper, createMessages } from './messages-outbox.js';
import { type MessagesAnswer, messagesRequest } from './messages-protocol.js';
import { writeJson } from './output.js';
import { keychain, type SecretStore } from './secrets.js';

const NO_TOKEN =
	'Create an access token in Beeper Settings → Integrations → Approved connections, then connect.';
const UNREACHABLE =
	'Could not reach Beeper. Make sure it is running and the access token is approved.';

/**
 * Whether Beeper answering `status` means it did not take the message: a
 * request it refused, but not a timeout or a conflict, after which it may
 * have.
 */
const refusedStatus = (status: number) =>
	status >= 400 && status < 500 && status !== 408 && status !== 409;

export function createBeeperConnection(
	secrets: SecretStore,
	fetcher: typeof fetch = fetch,
): Beeper {
	const entry = 'beeper-desktop';
	function client(token: string) {
		return new BeeperDesktop({
			accessToken: token,
			baseURL: 'http://127.0.0.1:23373',
			maxRetries: 0,
			timeout: 10000,
			fetch: fetcher,
		});
	}
	async function saved() {
		const token = await secrets.get(entry);
		return token ? client(token) : null;
	}
	async function profileOf(api: BeeperDesktop) {
		const accounts = await api.accounts.list();
		if (accounts.length === 0)
			throw new Error('No accounts are connected in Beeper.');
		return new Bun.CryptoHasher('sha256')
			.update(
				accounts
					.map((account) => account.accountID)
					.sort()
					.join('\n'),
			)
			.digest('hex');
	}
	return {
		async request(request): Promise<MessagesAnswer> {
			try {
				if (request.action === 'disconnect') {
					await secrets.delete(entry);
					return { kind: 'disconnected' };
				}
				const api =
					request.action === 'connect' && request.token
						? client(request.token)
						: await saved();
				if (!api) return { kind: 'error', message: NO_TOKEN };
				switch (request.action) {
					case 'connect': {
						const identity = await profileOf(api);
						if (request.token) await secrets.set(entry, request.token);
						return { kind: 'connected', profile: identity };
					}
					case 'chats': {
						const page = await api.chats.list({ cursor: request.cursor });
						return {
							kind: 'chats',
							page: {
								items: page.items.map((chat) => ({
									id: chat.id,
									title: chat.title,
									network: chat.network,
									preview:
										chat.preview?.text ??
										(chat.preview?.attachments?.length ? 'Attachment' : ''),
									activity: chat.lastActivity ?? '',
								})),
								cursor: page.hasMore ? page.oldestCursor : null,
							},
						};
					}
					case 'messages': {
						const page = await api.messages.list(request.chatId, {
							cursor: request.cursor,
							direction: 'before',
						});
						return {
							kind: 'messages',
							page: {
								items: page.items
									.filter((message) => !message.isHidden)
									.map((message) => ({
										id: message.id,
										text: message.isDeleted
											? 'Message deleted'
											: (message.text ?? ''),
										sender: message.senderName ?? message.senderID,
										mine: message.isSender === true,
										timestamp: message.timestamp,
										attachment: Boolean(message.attachments?.length),
										status: message.sendStatus?.status,
									})),
								cursor: page.hasMore ? page.oldestCursor : null,
							},
						};
					}
					case 'focus':
						await api.focus({ chatID: request.chatId });
						return { kind: 'focused' };
				}
			} catch {
				// SDK errors may contain request bodies. Never print them or expose them to the page.
				return { kind: 'error', message: UNREACHABLE };
			}
		},
		async profile() {
			try {
				const api = await saved();
				if (!api) return { message: 'Beeper is not connected.' };
				return { profile: await profileOf(api) };
			} catch {
				return { message: UNREACHABLE };
			}
		},
		async send(chatId, text) {
			let api: BeeperDesktop | null;
			try {
				api = await saved();
			} catch {
				api = null;
			}
			if (!api)
				return { kind: 'refused', message: 'Beeper is not connected.' };
			try {
				const sent = await api.messages.send(chatId, { text });
				return {
					kind: 'accepted',
					pendingId: sent.pendingMessageID,
					chatId: sent.chatID,
				};
			} catch (error) {
				// Only an answer from Beeper says it did not take the message; a
				// lost connection or timeout says nothing either way.
				if (
					error instanceof BeeperDesktop.APIError &&
					typeof error.status === 'number' &&
					refusedStatus(error.status)
				)
					return {
						kind: 'refused',
						message: `Beeper refused the message (status ${error.status}).`,
					};
				return { kind: 'unknown', message: 'Beeper did not confirm the send.' };
			}
		},
		async status(chatId, pendingId) {
			try {
				const api = await saved();
				if (!api) return { kind: 'error', message: 'Beeper is not connected.' };
				const message = await api.messages.retrieve(pendingId, {
					chatID: chatId,
				});
				return { kind: 'status', status: message.sendStatus?.status ?? null };
			} catch (error) {
				if (error instanceof BeeperDesktop.NotFoundError)
					return { kind: 'status', status: null };
				return { kind: 'error', message: UNREACHABLE };
			}
		},
	};
}

/**
 * Where Messages keeps its reply notes: `Messages` in the Epicenter folder
 * (`~/Epicenter/Messages`, or under `EPICENTER_FOLDER_DIR`), and its send
 * journal, under the app's data directory, outside any folder.
 */
export function messagesPaths(env = process.env) {
	const { folderDir, dataDir } = resolveAppPaths(env);
	return {
		folder: join(folderDir, 'Messages'),
		journal: join(dataDir, 'messages', 'sends.sqlite'),
	};
}

/** This installation's Beeper connection, whose token is in the device keychain. */
export function beeperConnection(): Beeper {
	// Development and explicit app-data locations never adopt another installation's token.
	const scope = new Bun.CryptoHasher('sha256')
		.update(process.env.EPICENTER_DATA_DIR ?? 'terminal')
		.digest('hex');
	return createBeeperConnection(keychain(`so.epicenter.messages.${scope}`));
}

/**
 * Messages' operations as `epicenter messages --json` answers them, over
 * the reply notes in `folder`, the send journal at `journal`, and
 * `beeper`: an operation that is not one `messagesRequest` admits is
 * refused, and any other goes to the one send owner (`createMessages`).
 * Messages' local program answers its page with this, so the page never
 * holds the token and every send, from either, is journaled the same way.
 */
export async function openMessages({
	folder,
	journal,
	beeper,
}: {
	folder: string;
	journal: string;
	beeper: Beeper;
}) {
	const device = await openDevice(messagesContract, { path: folder });
	if (device.error !== null) throw new Error(device.error.message);
	const sends = openSendJournal(journal);
	const owner = createMessages({
		replies: device.data.replies,
		journal: sends,
		beeper,
	});
	return {
		async answer(input: unknown): Promise<MessagesAnswer> {
			if (!Check(messagesRequest, input))
				return { kind: 'error', message: 'Invalid Messages operation.' };
			return owner.answer(input);
		},
		close: () => sends.close(),
	};
}

export async function messagesCommand() {
	let input: unknown;
	try {
		input = JSON.parse(await Bun.stdin.text());
	} catch {
		input = null;
	}
	let messages: Awaited<ReturnType<typeof openMessages>>;
	try {
		messages = await openMessages({
			...messagesPaths(),
			beeper: beeperConnection(),
		});
	} catch (error) {
		writeJson({
			kind: 'error',
			message: `The Messages folder could not be opened: ${error instanceof Error ? error.message : String(error)}`,
		} satisfies MessagesAnswer);
		return 1;
	}
	try {
		writeJson(await messages.answer(input));
	} finally {
		messages.close();
	}
	return Check(messagesRequest, input) ? 0 : 2;
}
