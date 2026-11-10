/** One page session, reading and changing mail only through the app's actions. */
import { type ActionOutput, connect } from '@epicenter/app/client';
import { toast } from '@epicenter/ui/sonner';
import type mail from '../../../epicenter.js';

type Actions = typeof mail.actions;
export type Search = ActionOutput<Actions['search']>;
export type Message = Search['messages'][number];
export type MessageFile = ActionOutput<Actions['show']>;
export const app = connect<typeof mail>('mail');

function createMail() {
	let result = $state.raw<Search>();
	let message = $state.raw<MessageFile>();
	let status = $state.raw<ActionOutput<Actions['status']>>();
	let labels = $state.raw<ActionOutput<Actions['labels']>>([]);
	let views = $state.raw<ActionOutput<Actions['views']['list']>>([]);
	let path = $state('');
	let query = $state('');
	let problem = $state<string>();
	let busy = $state(false);
	let loaded = $state(false);
	let sent = $state.raw<{ id: string; labels: string[] }[]>([]);
	let generation = 0;

	function errorMessage(error: unknown) {
		return error instanceof Error ? error.message : String(error);
	}
	async function reload() {
		const request = ++generation;
		const view = path.startsWith('views/') ? path : undefined;
		const id = path.startsWith('messages/')
			? path.slice('messages/'.length)
			: undefined;
		try {
			const [nextStatus, nextLabels, nextViews, nextSearch, nextMessage] =
				await Promise.all([
					app.status(),
					app.labels(),
					app.views.list(),
					app.search({ query, ...(view ? { view } : {}) }),
					id ? app.show({ id }) : Promise.resolve(undefined),
				]);
			if (request !== generation) return;
			status = nextStatus;
			labels = nextLabels;
			views = nextViews;
			result = nextSearch;
			message = nextMessage;
			problem = undefined;
		} catch (error) {
			if (request === generation) problem = errorMessage(error);
		} finally {
			if (request === generation) loaded = true;
		}
	}
	async function change(run: () => Promise<unknown>) {
		if (busy) return;
		busy = true;
		generation++;
		try {
			await run();
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			await reload();
			busy = false;
		}
	}
	return {
		result: () => result,
		message: () => message,
		status: () => status,
		labels: () => labels,
		views: () => views,
		path: () => path,
		query: () => query,
		problem: () => problem,
		busy: () => busy,
		loaded: () => loaded,
		sentLabels(id: string) {
			return sent.find((entry) => entry.id === id)?.labels ?? [];
		},
		async open(nextPath: string) {
			path = nextPath;
			query = nextPath.startsWith('search/')
				? decodeURIComponent(nextPath.slice('search/'.length))
				: '';
			message = undefined;
			result = undefined;
			loaded = false;
			await reload();
		},
		async search(nextQuery: string) {
			query = nextQuery;
			await reload();
		},
		reload,
		refresh: () => change(() => app.refresh()),
		async label(id: string, label: string, want: boolean) {
			await change(async () => {
				await app.label({
					ids: [id],
					add: want ? [label] : [],
					remove: want ? [] : [label],
				});
				sent = sent.map((entry) =>
					entry.id === id
						? { ...entry, labels: entry.labels.filter((l) => l !== label) }
						: entry,
				);
			});
		},
		async send() {
			await change(async () => {
				try {
					const answer = await app.reconcile();
					sent = answer.delivered.map((entry) => ({
						id: entry.id,
						labels: [...entry.added, ...entry.removed],
					}));
					const n = answer.delivered.length;
					const discarded = answer.discarded
						.map((entry) => entry.reason)
						.join('; ');
					toast.success(
						`Sent ${n} ${n === 1 ? 'change' : 'changes'} to Gmail`,
						{
							description: answer.discarded.length
								? `${answer.discarded.length} could not be sent: ${discarded}`
								: undefined,
						},
					);
				} catch (error) {
					toast.error(errorMessage(error), {
						description: 'Your changes are kept and will be sent next time.',
					});
				}
			});
		},
		async save(name: string, title: string) {
			const saved = await app.views.add({
				name,
				...(title ? { title } : {}),
				query: result?.query ?? query,
			});
			await reload();
			return saved.path;
		},
		watch(every = 15_000) {
			const onShow = () => {
				if (document.visibilityState === 'visible' && !busy) void reload();
			};
			onShow();
			const timer = setInterval(onShow, every);
			document.addEventListener('visibilitychange', onShow);
			window.addEventListener('focus', onShow);
			return () => {
				clearInterval(timer);
				document.removeEventListener('visibilitychange', onShow);
				window.removeEventListener('focus', onShow);
			};
		},
	};
}
export const mailbox = createMail();
