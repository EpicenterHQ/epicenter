import {
	defineAction,
	defineApp,
	defineCollection,
	field,
	folder,
	readMarkdown,
} from '@epicenter/app';
import { demoBeeper } from './beeper.ts';

const drafts = defineCollection({
	path: 'drafts/{chat}.md',
	description: 'reply being written to one conversation; its text is the body',
	fields: {},
});
const sends = defineCollection({
	path: 'sends/{chat}.md',
	description: 'the latest send to one conversation; the text sent is the body',
	fields: {
		attempt: field.text({
			description: 'The id of this attempt, named when resolving it',
		}),
		state: field.select(['sending', 'sent', 'unconfirmed', 'not-sent'], {
			description:
				'Whether Beeper confirmed this attempt or a person resolved it',
		}),
		at: field.datetime({
			description:
				'When this attempt claimed the conversation before asking Beeper',
		}),
		messageId: field.text({
			optional: true,
			description: 'The message id Beeper returned',
		}),
		error: field.text({
			optional: true,
			description: 'What prevented confirmation',
		}),
		checked: field.datetime({
			optional: true,
			description: 'When a person resolved this attempt',
		}),
	},
});
const SEND_DEADLINE_MS = 30_000;
const unchanged = Symbol('unchanged');
const bodyOf = (text: string) =>
	text === '' || text.endsWith('\n') ? text : `${text}\n`;
const textOf = (body: string) =>
	body.endsWith('\n') ? body.slice(0, -1) : body;
const draftPath = (chat: string) => ({ path: drafts.pathOf({ chat }) });
const sendPath = (chat: string) => ({ path: sends.pathOf({ chat }) });
function chatOf(chat: string) {
	const found = demoBeeper.conversation(chat);
	if (!found) throw new Error(`There is no conversation ${chat}`);
	return found;
}
function refuse(message: string): never {
	throw Object.freeze({ name: 'Refused', message });
}
function changed(title: string): never {
	throw Object.freeze({
		name: 'Changed',
		message: `The draft to ${title} changed. Read the conversation again before saving or sending.`,
	});
}
type SendFile = NonNullable<Awaited<ReturnType<typeof sends.get>>>;
function sendProblems(row: SendFile): string[] {
	if (row.problems?.length) return row.problems;
	if (!row.at || !row.attempt || !row.state)
		return [`${row.path} needs repair before sending`];
	return [];
}
function sendView(row: SendFile | undefined): {
	send?: ReturnType<typeof summary>;
	sendProblems?: string[];
} {
	if (!row) return {};
	const problems = sendProblems(row);
	return problems.length ? { sendProblems: problems } : { send: summary(row) };
}
function summary(row: SendFile) {
	if (!row.at || !row.attempt || !row.state)
		throw new Error(
			`The send record ${row.path} needs repair before Messages can use it`,
		);
	return {
		attempt: row.attempt,
		state: row.state,
		at: row.at,
		text: textOf(row.body),
		...(row.messageId === undefined ? {} : { messageId: row.messageId }),
		...(row.error === undefined ? {} : { error: row.error }),
		...(row.checked === undefined ? {} : { checked: row.checked }),
		needsCheck:
			row.state === 'unconfirmed' ||
			(row.state === 'sending' &&
				Date.now() - Date.parse(row.at) > SEND_DEADLINE_MS),
	};
}
async function readDraft(chat: string) {
	return textOf((await drafts.get(draftPath(chat)))?.body ?? '');
}
/** The previous check runs again if a competing write wins. */
async function saveDraft(
	chat: string,
	text: string,
	previous?: string,
	onlyEmpty = false,
) {
	const title = chatOf(chat).title;
	if (!(await drafts.get(draftPath(chat)))) {
		if (previous !== undefined && previous !== '') changed(title);
		if (text === '') return;
		try {
			await drafts.add({ chat, body: bodyOf(text) });
			return;
		} catch (error) {
			if (!(await drafts.get(draftPath(chat)))) throw error;
		}
	}
	try {
		await drafts.update(draftPath(chat), (row) => {
			const current = textOf(row.body);
			if (onlyEmpty && current !== '') throw unchanged;
			if (previous !== undefined && current !== previous) changed(title);
			if (current === text) throw unchanged;
			return { body: bodyOf(text) };
		});
	} catch (error) {
		if (error !== unchanged) throw error;
	}
}
const chatInput = { chat: field.text({ description: 'The conversation id' }) };
const reads = { readOnlyHint: true, openWorldHint: true };
const writes = {
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};
/** List fictional conversations with their drafts and latest send records. */
const conversations = defineAction({
	description:
		'List fictional conversations, newest activity first, with their drafts and latest sends',
	input: {},
	annotations: reads,
	run: async () =>
		Promise.all(
			(await demoBeeper.conversations()).map(async (row) => {
				const draft = await readDraft(row.chat);
				const send = await sends.get(sendPath(row.chat));
				return {
					...row,
					...(draft === '' ? {} : { draft }),
					...sendView(send),
				};
			}),
		),
});
/** Read one conversation without hiding messages behind a broken send record. */
const read = defineAction({
	description:
		'Read a fictional conversation, its saved draft, and latest send',
	input: chatInput,
	positional: ['chat'],
	annotations: reads,
	run: async ({ chat }) => {
		const row = chatOf(chat);
		const send = await sends.get(sendPath(chat));
		return {
			...row,
			messages: await demoBeeper.messages(chat),
			draft: await readDraft(chat),
			...sendView(send),
		};
	},
});
/** Save the whole draft, checking the version the caller last read. */
const draft = defineAction({
	description: 'Save the whole draft reply to a conversation',
	input: {
		...chatInput,
		text: field.text({ description: "The whole draft; '' clears it" }),
		previous: field.text({
			optional: true,
			description:
				'The draft as you last read it; a changed draft is refused as Changed',
		}),
	},
	positional: ['chat', 'text'],
	annotations: writes,
	run: async ({ chat, text, previous }) => {
		await saveDraft(chat, text, previous);
		return { chat, draft: await readDraft(chat) };
	},
});
/** Claim one saved draft and ask Beeper once; never retry an uncertain delivery. */
const send = defineAction({
	description:
		"Send this conversation's saved draft; not safe to repeat. Keeps its own record in sends/<chat>.md, refuses while the last send is unconfirmed, and never resends on its own. Returns an unconfirmed send with outcome unconfirmed",
	input: {
		...chatInput,
		text: field.text({
			optional: true,
			description:
				'The draft as you last read it; a different saved draft is refused as Changed',
		}),
	},
	positional: ['chat'],
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	run: async ({ chat, text }) => {
		const { title } = chatOf(chat);
		const current = (await readDraft(chat)).trim();
		if (current === '') refuse(`There is no draft to send to ${title}`);
		if (text !== undefined && text.trim() !== current) changed(title);
		const at = new Date().toISOString();
		const attempt = `${at.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 6)}`;
		const body = bodyOf(current);
		/** Claim the conversation before consuming its draft or asking Beeper. */
		const path = sends.pathOf({ chat });
		const raw = await folder.read(path);
		const previousAttempt =
			raw === undefined ? undefined : readMarkdown(raw).fields.attempt;
		let claimed = false;
		if (raw === undefined) {
			try {
				await sends.add({ chat, attempt, state: 'sending', at, body });
				claimed = true;
			} catch (error) {
				if (!(await sends.get(sendPath(chat)))) throw error;
			}
		}
		if (!claimed)
			await sends.update(sendPath(chat), (row) => {
				if (sendProblems(row).length)
					refuse(`${row.path} needs repair before sending to ${title}`);
				if (row.state === 'sending' || row.state === 'unconfirmed')
					refuse(
						`The last message to ${title} is not confirmed. Check the conversation, then resolve it before sending again.`,
					);
				if (row.attempt !== previousAttempt)
					refuse(
						`The send record to ${title} changed. Read the conversation again.`,
					);
				return {
					attempt,
					state: 'sending',
					at,
					messageId: null,
					error: null,
					checked: null,
					body,
				};
			});
		async function record(
			patch: {
				state: 'sent' | 'not-sent' | 'unconfirmed';
				error?: string | null;
				messageId?: string;
			},
			mustBeSending = false,
		) {
			try {
				await sends.update(sendPath(chat), (row) => {
					if (
						row.attempt !== attempt ||
						(mustBeSending && row.state !== 'sending')
					)
						throw unchanged;
					return patch;
				});
			} catch (error) {
				if (error !== unchanged) throw error;
			}
		}
		/** Consume only the draft we read; otherwise restore the pre-claim record. */
		try {
			await drafts.update(draftPath(chat), (row) => {
				if (textOf(row.body).trim() !== current) changed(title);
				return { body: '' };
			});
		} catch (error) {
			if (raw !== undefined) {
				try {
					await folder.update(path, (now) => {
						if (
							now === undefined ||
							readMarkdown(now).fields.attempt !== attempt
						)
							throw unchanged;
						return raw;
					});
				} catch (restoreError) {
					if (restoreError !== unchanged) throw restoreError;
				}
			} else if ((await sends.get(sendPath(chat)))?.attempt === attempt) {
				await folder.delete(path);
			}
			throw error;
		}
		/** Ask Beeper once. A missing answer cannot establish whether it delivered. */
		let result: { id: string };
		try {
			result = await demoBeeper.send(chat, current);
		} catch (cause) {
			await record(
				{
					state: 'unconfirmed',
					error: cause instanceof Error ? cause.message : String(cause),
				},
				true,
			);
			return {
				outcome: 'unconfirmed' as const,
				chat,
				send: summary((await sends.get(sendPath(chat)))!),
				next: `Beeper did not confirm the message to ${title}. It may have been sent: check the conversation, then run epicenter messages resolve ${chat} sent|not-sent --attempt ${attempt}. Messages will not send it again on its own.`,
			};
		}
		/** Record confirmation against this attempt, preserving any newer attempt. */
		await record({ state: 'sent', messageId: result.id, error: null });
		return {
			outcome: 'sent' as const,
			chat,
			send: summary((await sends.get(sendPath(chat)))!),
		};
	},
});
/** Record a person’s check of the latest attempt without asking Beeper. */
const resolve = defineAction({
	description:
		'Record what a person checked about the latest send; never asks Beeper',
	input: {
		...chatInput,
		attempt: field.text({
			description: 'The attempt id from reading this conversation',
		}),
		outcome: field.select(['sent', 'not-sent'], {
			description: 'What you checked in the conversation',
		}),
	},
	positional: ['chat', 'outcome'],
	annotations: writes,
	run: async ({ chat, attempt, outcome }) => {
		const { title } = chatOf(chat);
		const mismatch = () =>
			refuse(
				`The latest send to ${title} is not that attempt; read the conversation again`,
			);
		if (!(await sends.get(sendPath(chat)))) mismatch();
		let resolved: SendFile | undefined;
		let alreadyResolved = false;
		try {
			resolved = await sends.update(sendPath(chat), (row) => {
				if (row.attempt !== attempt) mismatch();
				if (row.state === 'sent' || row.state === 'not-sent') {
					if (row.state === outcome) {
						resolved = row;
						alreadyResolved = true;
						throw unchanged;
					}
					refuse(
						`The latest send to ${title} was already resolved as ${row.state}. Read the conversation again.`,
					);
				}
				if (row.state === 'sending' && !summary(row).needsCheck)
					refuse(
						`The message to ${title} is still being sent. Check again shortly.`,
					);
				return { state: outcome, checked: new Date().toISOString() };
			});
		} catch (error) {
			if (error !== unchanged) throw error;
		}
		const row = resolved!;
		if (!alreadyResolved && outcome === 'not-sent')
			await saveDraft(chat, textOf(row.body), undefined, true);
		return { chat, send: summary(row), draft: await readDraft(chat) };
	},
});
export default defineApp({
	description:
		'Fictional Beeper conversations (a demo: nothing reaches Beeper): read them, keep a draft reply per conversation, and send it once',
	collections: { drafts, sends },
	actions: { conversations, read, draft, send, resolve },
});
