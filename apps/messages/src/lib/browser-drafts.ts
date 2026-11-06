/**
 * Drafts an earlier Messages kept in this browser's files for this origin
 * (OPFS): `drafts/<id>.md`, the reply being written in one conversation,
 * and `attempts/<id>.md`, the latest send from it. Messages now keeps
 * replies in the Messages folder on this computer, so these are only read:
 * nothing here writes or deletes them, and each can be copied, or imported
 * into the folder as a new draft (`BrowserDrafts.svelte`).
 */
import { defineContract } from '@epicenter/definition/contract';
import { closeDevice, openDevice } from '@epicenter/folder/browser';

const mode = { enum: ['demo', 'live'] } as const;

/** The contract those files were written under, kept to read them. */
export const browserDrafts = defineContract({
	name: 'messages',
	description:
		'Messages, before its folder: a Markdown note per conversation draft, and one for the latest send from it, kept in the browser.',
	collections: {
		drafts: {
			path: 'drafts/{id}.md',
			fields: { chatId: { type: 'string' }, profile: { type: 'string' }, mode },
			required: ['chatId', 'profile', 'mode'],
		},
		attempts: {
			path: 'attempts/{id}.md',
			fields: {
				chatId: { type: 'string' },
				profile: { type: 'string' },
				mode,
				state: { enum: ['sending', 'accepted', 'acknowledged'] },
				attemptId: { type: 'string' },
				pendingId: { type: 'string' },
			},
			required: [
				'chatId',
				'profile',
				'mode',
				'state',
				'attemptId',
				'pendingId',
			],
		},
	},
});

/**
 * One piece of text worth keeping: a live draft with text, a send Beeper
 * never confirmed, or a note that does not read (its text as it is, with no
 * conversation to import it to). `importId` is the reply id an import
 * creates, the same each time, so importing twice is refused.
 */
export type BrowserDraft = {
	path: string;
	kind: 'draft' | 'unconfirmed send' | 'unreadable';
	text: string;
	chatId?: string;
	profile?: string;
	importId: string;
};

/**
 * This browser's earlier drafts, or none when it keeps no files for this
 * origin. Demo drafts were fictional and are left where they are.
 */
export async function readBrowserDrafts(): Promise<BrowserDraft[]> {
	if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory)
		return [];
	const device = await openDevice(browserDrafts);
	if (device.error !== null) return [];
	try {
		const [drafts, attempts] = await Promise.all([
			device.data.drafts.list(),
			device.data.attempts.list(),
		]);
		const found: BrowserDraft[] = [];
		if (drafts.error === null) {
			for (const note of drafts.data.items)
				if (note.mode === 'live' && note.body.trim())
					found.push({
						path: `drafts/${note.id}.md`,
						kind: 'draft',
						text: note.body,
						chatId: note.chatId,
						profile: note.profile,
						importId: `browser-draft-${note.id}`,
					});
			for (const note of drafts.data.invalid)
				if (note.text?.trim())
					found.push({
						path: note.path,
						kind: 'unreadable',
						text: note.text,
						importId: `browser-draft-${note.id}`,
					});
		}
		if (attempts.error === null) {
			for (const note of attempts.data.items)
				if (note.mode === 'live' && note.state === 'sending')
					found.push({
						path: `attempts/${note.id}.md`,
						kind: 'unconfirmed send',
						text: note.body,
						chatId: note.chatId,
						profile: note.profile,
						importId: `browser-send-${note.id}`,
					});
			for (const note of attempts.data.invalid)
				if (note.text?.trim())
					found.push({
						path: note.path,
						kind: 'unreadable',
						text: note.text,
						importId: `browser-send-${note.id}`,
					});
		}
		return found;
	} finally {
		closeDevice(device.data);
	}
}
