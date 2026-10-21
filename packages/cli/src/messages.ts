/** Beeper's device connection. No message history or token is written to a folder. */
import BeeperDesktop from '@beeper/desktop-api';
import type { SecretStore } from '@epicenter/ai/send';
import { Check } from 'typebox/value';
import {
	type BeeperAnswer,
	type BeeperRequest,
	beeperRequest,
} from './messages-protocol.js';
import { writeJson } from './output.js';
import { keychain } from './secrets.js';

export function createBeeperConnection(
	secrets: SecretStore,
	fetcher: typeof fetch = fetch,
) {
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
	async function profile(api: BeeperDesktop) {
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
		async request(request: BeeperRequest): Promise<BeeperAnswer> {
			try {
				if (request.action === 'disconnect') {
					await secrets.delete(entry);
					return { kind: 'disconnected' };
				}
				const token =
					request.action === 'connect' && request.token
						? request.token
						: await secrets.get(entry);
				if (!token)
					return {
						kind: 'error',
						message:
							'Create an access token in Beeper Settings → Integrations → Approved connections, then connect.',
					};
				const api = client(token);
				switch (request.action) {
					case 'connect': {
						const identity = await profile(api);
						if (request.token) await secrets.set(entry, token);
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
					case 'send': {
						if ((await profile(api)) !== request.profile)
							return {
								kind: 'error',
								message:
									'The connected accounts changed. Reconnect before sending.',
							};
						if (!request.text.trim())
							return { kind: 'error', message: 'Write a message first.' };
						const sent = await api.messages.send(request.chatId, {
							text: request.text,
						});
						return { kind: 'accepted', pendingId: sent.pendingMessageID };
					}
					case 'focus':
						await api.focus({ chatID: request.chatId });
						return { kind: 'focused' };
				}
			} catch {
				// SDK errors may contain request bodies. Never print them or expose them to the page.
				return {
					kind: 'error',
					message:
						request.action === 'send'
							? 'Beeper did not confirm the request. Check the conversation in Beeper before sending again.'
							: 'Could not reach Beeper. Make sure it is running and the access token is approved.',
				};
			}
		},
	};
}

export async function messagesCommand() {
	let input: unknown;
	try {
		input = JSON.parse(await Bun.stdin.text());
	} catch {
		input = null;
	}
	if (!Check(beeperRequest, input)) {
		writeJson({
			kind: 'error',
			message: 'Invalid Beeper operation.',
		} satisfies BeeperAnswer);
		return 2;
	}
	// Development and explicit app-data locations never adopt another installation's token.
	const scope = new Bun.CryptoHasher('sha256')
		.update(process.env.EPICENTER_DATA_DIR ?? 'terminal')
		.digest('hex');
	const connection = createBeeperConnection(
		keychain(`so.epicenter.messages.${scope}`),
	);
	writeJson(await connection.request(input));
	return 0;
}
