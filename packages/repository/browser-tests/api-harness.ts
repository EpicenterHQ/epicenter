/**
 * The page the repository API's browser tests drive: Todos on
 * `openRepository` over this tab's replica (`api/browser`), wrapped with
 * `reactive` and shown by one Svelte app mounted once per page load. Its
 * host can hold the worker's answers to writes, so a test types while one
 * is in flight. Calls a test makes are on `globalThis.api`.
 */
import { mount } from 'svelte';
import { reactive } from '../../svelte/src/repository/index.js';
import { browserHost } from '../src/api/browser-host.js';
import type { Editor } from '../src/api/editor.js';
import { collectionsOf } from '../src/api/local.js';
import {
	type Host,
	type HostState,
	openRepository,
	type Session,
} from '../src/api/repository.js';
import { bodyOf } from '../src/core/markdown.js';
import {
	createBrowserReplica,
	openBrowserReplica,
	type ReplicaTab,
	type Syncing,
} from '../src/hosts/browser/index.js';
import App from './api-page/App.svelte';
import { todosApp } from './api-page/app.js';

const worker = () => new Worker('/replica-worker.js', { type: 'module' });
let repository: ReturnType<
	typeof openRepository<(typeof todosApp)['definitions']>
> | null = null;
let editor: Editor | undefined;
let holding = false;
/** Whether changes stored meanwhile are held from the page too, as a page that has not heard them yet. */
let holdingDeltas = false;
/** How many times the editor replaced its draft from outside (a rebase, or a change followed). */
let replacements = 0;
const held: (() => void)[] = [];

/** The tab's host, its answers to writes (and with `deltas`, the changes it hears) held while `hold` is on, released in the order they came. */
function holdable(inner: Host): Host {
	const sessions = new WeakMap<Session, Session>();
	const wrap = (session: Session): Session => {
		let wrapped = sessions.get(session);
		if (wrapped === undefined) {
			wrapped = {
				...session,
				change(changes, token) {
					const answered = session.change(changes, token);
					if (!holding) return answered;
					answered.catch(() => {});
					return new Promise((resolve, reject) =>
						held.push(() => answered.then(resolve, reject)),
					);
				},
				watch(listener) {
					return session.watch((delta) => {
						if (holding && holdingDeltas) held.push(() => listener(delta));
						else listener(delta);
					});
				},
			};
			sessions.set(session, wrapped);
		}
		return wrapped;
	};
	return {
		subscribe: (onState) =>
			inner.subscribe((state: HostState) =>
				onState(
					state.status === 'open'
						? { status: 'open', session: wrap(state.session) }
						: state,
				),
			),
		close: () => inner.close(),
	};
}

function show(tab: ReplicaTab) {
	repository = reactive(
		openRepository({ app: todosApp, host: holdable(browserHost(tab)) }),
	);
	const target = document.createElement('div');
	document.body.append(target);
	mount(App, {
		target,
		props: {
			repo: repository,
			onEditor(opened: Editor | undefined) {
				editor = opened;
				opened?.subscribe(({ replaced }) => {
					if (replaced !== null) replacements++;
				});
			},
		},
	});
	return tab.replica;
}
const repo = () => {
	if (repository === null) throw new Error('No repository is open');
	return repository;
};
const options = (token: string) => ({
	collections: collectionsOf(todosApp),
	headers: { authorization: `Bearer ${token}` } as Record<string, string>,
	worker,
});

/** Poll `check` until it holds. */
async function until(check: () => boolean, what: string, timeout = 15_000) {
	const deadline = Date.now() + timeout;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const calls = {
	async create(
		name: string,
		{ token, ...syncing }: Syncing & { token: string },
	) {
		const created = await createBrowserReplica({
			owner: null,
			repository: name,
			name,
			...syncing,
			...options(token),
		});
		if (created.error !== null) throw new Error(created.error.message);
		return show(created.data);
	},
	open: (replica: string, token: string) =>
		show(openBrowserReplica({ replica, ...options(token) })),
	status: () => repo().status().status,
	untilOpen: () =>
		until(
			() => repository?.status().status === 'open',
			'the repository to open',
		),
	untilStatus: (status: string) =>
		until(
			() => repository?.status().status === status,
			`the repository to be ${status}`,
		),
	add: async (stem: string, title: string, body: string) =>
		(
			await repo().todos.create(
				{ stem },
				{ fields: { title, done: false }, body },
			)
		).error,
	todos: () =>
		repo()
			.todos.all()
			.map((todo) => ({
				stem: todo.params.stem,
				done: todo.valid ? todo.fields.done : null,
				body: todo.body,
				state: todo.state.status,
			})),
	untilBody: (stem: string, body: string) =>
		until(
			() => repo().todos.get({ stem })?.body === body,
			`${stem} to read ${JSON.stringify(body)}`,
		),
	/** Write a todo's body as exact source made from `over`, as another app or device would. */
	writeBody: async (stem: string, body: string, over: string) => {
		const todo = repo().todos.get({ stem });
		if (todo === undefined) throw new Error(`no todo ${stem}`);
		const header = todo.text.slice(0, todo.text.length - todo.body.length);
		return (
			await repo().todos.write({ stem }, `${header}${body}`, {
				over: `${header}${over}`,
			})
		).error;
	},
	/** The text the worker holds now, under any draft. */
	stored: async (stem: string) => {
		const rows = await repo().query<{ text: string }>(
			'SELECT text FROM "epicenter/files" WHERE path = ?',
			[`todos/${stem}.md`],
		);
		return rows.error === null ? (rows.data[0]?.text ?? null) : null;
	},
	untilStored: async (stem: string, part: string) => {
		const deadline = Date.now() + 15_000;
		for (;;) {
			const text = await calls.stored(stem);
			if (text?.includes(part)) return text;
			if (Date.now() > deadline)
				throw new Error(
					`Timed out waiting for ${stem} to hold ${JSON.stringify(part)}: ${JSON.stringify(text)}`,
				);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	},
	/** The editor's draft as the body view shows it. */
	editorDraft: () => (editor === undefined ? null : bodyOf(editor.draft())),
	replacements: () => replacements,
	editorState: () => editor?.state().status ?? null,
	untilEditorSaved: () =>
		until(() => editor?.state().status === 'saved', 'the editor to save'),
	/** Hold the worker's answers to writes, and with `deltas`, the changes the page hears. */
	hold({ deltas = false }: { deltas?: boolean } = {}) {
		holding = true;
		holdingDeltas = deltas;
	},
	release() {
		holding = false;
		holdingDeltas = false;
		for (const go of held.splice(0)) go();
	},
	mounts: () => (globalThis as { mounts?: number }).mounts ?? 0,
	freeze: () => document.dispatchEvent(new Event('freeze')),
	resume: () => document.dispatchEvent(new Event('resume')),
	/** The page is hidden for the back-forward cache, and shown again. */
	pagehide: () =>
		dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
	pageshow: () =>
		dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
};

declare global {
	var api: typeof calls;
}
globalThis.api = calls;
export type ApiHarness = typeof calls;
