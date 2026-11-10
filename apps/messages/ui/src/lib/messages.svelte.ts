import { type ActionOutput, connect } from '@epicenter/app/client';
import { untrack } from 'svelte';
import type messagesApp from '../../../epicenter.js';

type Actions = typeof messagesApp.actions;
export const app = connect<typeof messagesApp>('messages');
export type ConversationRow = ActionOutput<Actions['conversations']>[number];
export type Conversation = ActionOutput<Actions['read']>;

/** The tagged name carried by an action's thrown answer. */
export function thrownName(error: unknown): string | undefined {
	if (!error || typeof error !== 'object' || !('answer' in error)) return;
	const { answer } = error;
	if (!answer || typeof answer !== 'object' || !('threw' in answer)) return;
	const { threw } = answer;
	if (!threw || typeof threw !== 'object' || !('thrown' in threw)) return;
	const { thrown } = threw;
	if (!thrown || typeof thrown !== 'object' || !('name' in thrown)) return;
	return typeof thrown.name === 'string' ? thrown.name : undefined;
}

export function messageOf(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

let rows = $state.raw<ConversationRow[]>();
let problem = $state('');
let reads = 0;

/** One list shared by the sidebar and the conversation's writes. */
export const list = {
	rows: () => rows,
	problem: () => problem,
	async refresh() {
		const request = ++reads;
		try {
			const next = await app.conversations();
			if (request !== reads) return;
			rows = next;
			problem = '';
		} catch (error) {
			if (request === reads) problem = messageOf(error);
		}
	},
};

/** Refresh only while visible, and when this window returns to view. */
export function watch(refresh: () => Promise<void>, interval: number) {
	const visible = () => {
		if (document.visibilityState === 'visible') void refresh();
	};
	untrack(visible);
	const timer = setInterval(visible, interval);
	window.addEventListener('focus', visible);
	document.addEventListener('visibilitychange', visible);
	return () => {
		clearInterval(timer);
		window.removeEventListener('focus', visible);
		document.removeEventListener('visibilitychange', visible);
	};
}
