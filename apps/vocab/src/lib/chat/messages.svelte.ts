import {
	type AgentMessage,
	type AgentMessageStore,
	AgentMessageStoreError,
} from '@epicenter/agent';
import { untrack } from 'svelte';
import { Ok } from 'wellcrafted/result';
import {
	readMessage,
	readRows,
	rowPath,
	type UnreadableFile,
	type VocabFolder,
} from '../data.js';
import { ChatHistoryError } from './chats.js';

function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const keys = (value: object) =>
		Object.keys(value).filter((key) => Reflect.get(value, key) !== undefined);
	const [left, right] = [keys(a), keys(b)];
	return (
		left.length === right.length &&
		left.every((key) => sameJson(Reflect.get(a, key), Reflect.get(b, key)))
	);
}

export const messageId = (chatId: string, id: string) => `${chatId}.${id}`;

/** One chat's finished messages, read synchronously from the folder mirror. */
export function createChatMessageStore(
	folder: VocabFolder,
	chatId: string,
): AgentMessageStore & {
	readonly unreadable: UnreadableFile[];
} {
	const mine = () =>
		folder.tables.messages.rows.filter((row) =>
			row.id.startsWith(`${chatId}.`),
		);
	const listing = () => readRows('messages', mine(), readMessage);
	return {
		get unreadable() {
			return listing().unreadable;
		},
		*entries() {
			const deduped = new Map<string, { id: string; message: AgentMessage }>();
			for (const row of listing().rows) {
				if (row.chat !== chatId) continue;
				const previous = deduped.get(row.message.id);
				if (!previous || row.id < previous.id) deduped.set(row.message.id, row);
			}
			for (const [key, { message: val }] of deduped) yield { key, val };
		},
		observe(handler) {
			let previous = folder.tables.messages.rows;
			return $effect.root(() => {
				$effect(() => {
					const rows = folder.tables.messages.rows;
					if (rows === previous) return;
					previous = rows;
					untrack(handler);
				});
			});
		},
		async set(key, value) {
			const id = messageId(chatId, key);
			// SAFETY: JSON serialization removes unsupported values from the typed agent message.
			const message = JSON.parse(JSON.stringify(value)) as AgentMessage;
			const same = (row: ReturnType<typeof folder.tables.messages.row>) =>
				row?.issues === null &&
				row.fields.chat === chatId &&
				sameJson(row.fields.message, message);
			const taken = () => {
				const { error } = ChatHistoryError.Taken({
					path: rowPath('messages', id),
				});
				return AgentMessageStoreError.WriteFailed({ cause: error });
			};
			const existing = folder.tables.messages.row(id);
			if (existing) return same(existing) ? Ok(undefined) : taken();
			const { error } = await folder.tables.messages.create(id, {
				fields: { chat: chatId, message },
			});
			if (error?.name === 'Exists') {
				const now = folder.tables.messages.row(id);
				return now && same(now) ? Ok(undefined) : taken();
			}
			return error
				? AgentMessageStoreError.WriteFailed({ cause: error })
				: Ok(undefined);
		},
		[Symbol.dispose]() {},
	};
}
