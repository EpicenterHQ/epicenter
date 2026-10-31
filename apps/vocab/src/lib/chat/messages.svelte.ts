/**
 * One chat's finished messages as the tutor loop's store, over one client's
 * `messages/{chat}/{id}.md` notes: each message is one note, its id the
 * message's own, so writing one twice never makes two.
 */
import {
	type AgentMessage,
	type AgentMessageStore,
	AgentMessageStoreError,
} from '@epicenter/agent';
import { sameValue } from '@epicenter/definition/note';
import type { ReactiveNotes } from '@epicenter/svelte/client';
import { untrack } from 'svelte';
import { Ok } from 'wellcrafted/result';
import type { Vocab } from '../contract.js';
import {
	type MessageNote,
	readMessage,
	reasonOf,
	type UnreadableFile,
} from '../data.js';
import { ChatHistoryError } from './chats.js';

export type MessageList = ReactiveNotes<Vocab['collections']['messages']>;

const messagePath = (chat: string, id: string) => `messages/${chat}/${id}.md`;

/** Whether `note` holds `message`, whole. */
const holds = (note: MessageNote | undefined, message: AgentMessage) =>
	note !== undefined &&
	note.role === message.role &&
	note.createdAt === message.createdAt &&
	sameValue(note.parts, message.parts);

export function createChatMessageStore(
	list: MessageList,
	chatId: string,
): AgentMessageStore & {
	/** This chat's message notes that do not read: not shown, not sent to the tutor. */
	readonly unreadable: UnreadableFile[];
} {
	return {
		get unreadable() {
			return list.invalid
				.filter((note) => note.chat === chatId)
				.map(({ path, issues }) => ({ path, reason: reasonOf(issues) }));
		},
		*entries() {
			for (const note of list.items)
				if (note.chat === chatId)
					yield { key: note.id, val: readMessage(note) };
		},
		observe(handler) {
			let first = true;
			return $effect.root(() => {
				$effect(() => {
					// Read the list's notes: any change to them is one to hear, after the first read.
					list.items;
					if (first) {
						first = false;
						return;
					}
					untrack(handler);
				});
			});
		},
		async set(key, value) {
			// SAFETY: JSON serialization removes unsupported values from the typed agent message.
			const message = JSON.parse(JSON.stringify(value)) as AgentMessage;
			const args = { chat: chatId, id: key };
			const taken = () => {
				const { error } = ChatHistoryError.Taken({
					path: messagePath(chatId, key),
				});
				return AgentMessageStoreError.WriteFailed({ cause: error });
			};
			const existing = list.get(args);
			if (existing) return holds(existing, message) ? Ok(undefined) : taken();
			const { role, createdAt, parts } = message;
			const { error } = await list.create({
				...args,
				role,
				createdAt,
				parts,
				body: '',
			});
			if (error?.name === 'Occupied')
				return holds(list.get(args), message) ? Ok(undefined) : taken();
			return error
				? AgentMessageStoreError.WriteFailed({ cause: error })
				: Ok(undefined);
		},
		[Symbol.dispose]() {},
	};
}
