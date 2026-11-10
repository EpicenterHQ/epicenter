/**
 * The task list as the server last gave it, with this page's own writes
 * shown before they land. Everything is asked of `epicenter serve` through
 * the app's actions; nothing is kept on the device.
 */
import { type ActionInput, type ActionOutput, connect } from '@epicenter/app/client';
import { toast } from '@epicenter/ui/sonner';
import type tasksApp from '../../../epicenter.js';

type Actions = (typeof tasksApp)['actions'];

/**
 * Tasks' actions, asked of the server that serves this UI. A change saved to
 * its file but not recorded in the folder's history says so, with the command
 * that records it.
 */
export const app = connect<typeof tasksApp>('tasks', {
	onUncommitted: ({ sync }) =>
		toast.warning('Saved to the file, but not recorded in history', {
			id: 'uncommitted',
			description: `To record it, run ${sync} on the computer that runs Epicenter.`,
		}),
});

/** A row of `tasks list`: a task's path and fields, without its notes; `problems` when its file does not fit. */
export type Task = ActionOutput<Actions['list']>[number];

/** What `tasks get`, `set`, and `edit` answer: a task's path, fields, and notes. */
export type TaskFile = ActionOutput<Actions['get']>;

/** The fields `tasks set` takes besides the path. */
export type TaskChanges = Omit<ActionInput<Actions['set']>, 'path'>;

function createTaskList() {
	let rows = $state.raw<Task[]>([]);
	let loaded = $state(false);
	let problem = $state<string>();
	/** Done changes sent and not yet answered, by path, shown over the server's rows. */
	let pending = $state.raw(new Map<string, boolean>());
	/** Counts writes, so a list asked for before a write does not undo it on screen. */
	let writes = 0;

	function replace(path: string, change: (task: Task) => Task | undefined) {
		rows = rows.flatMap((task) => {
			if (task.path !== path) return [task];
			const next = change(task);
			return next ? [next] : [];
		});
	}

	async function refresh() {
		const before = writes;
		try {
			const next = await app.list();
			if (before !== writes) return;
			rows = next;
			problem = undefined;
		} catch (error) {
			problem = error instanceof Error ? error.message : String(error);
		} finally {
			loaded = true;
		}
	}

	return {
		/** Every task, with done changes still on their way shown as sent. */
		rows() {
			if (pending.size === 0) return rows;
			return rows.map((task) =>
				pending.has(task.path) ? { ...task, done: pending.get(task.path) as boolean } : task,
			);
		},
		/** Whether the first list has come back. */
		loaded: () => loaded,
		/** Why the last list did not come back, if it did not. */
		problem: () => problem,

		/** Ask for the list again; a list asked for before a write is dropped. */
		refresh,

		/** Add a task titled `title`; resolves to its row. */
		async add(title: string) {
			writes++;
			const { body: _, other: __, ...task } = await app.add({ title });
			rows = [...rows.filter((row) => row.path !== task.path), task];
			return task;
		},

		/** Mark the task at `path` done or not, shown at once and undone on screen if the write fails. */
		async setDone(path: string, done: boolean) {
			writes++;
			pending = new Map(pending).set(path, done);
			try {
				const file = await app.set({ path, done });
				replace(path, (task) => ({ ...task, done: file.done }));
			} finally {
				const next = new Map(pending);
				next.delete(path);
				pending = next;
			}
		},

		/** Note what `tasks set` answered for a task changed elsewhere in the UI. */
		changed(file: TaskFile) {
			writes++;
			const { body: _, other: __, ...task } = file;
			replace(file.path, () => task);
		},

		/** Delete the task at `path`; it leaves the list at once. */
		async remove(path: string) {
			writes++;
			replace(path, () => undefined);
			await app.delete({ path });
		},

		/**
		 * Keep the list current while the page is visible: on showing again,
		 * and every `every` milliseconds, so tasks an agent adds appear.
		 * Returns the cleanup.
		 */
		watch(every = 15_000) {
			const onShow = () => {
				if (document.visibilityState === 'visible') void refresh();
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

/** The one task list every page of the UI reads. */
export const tasks = createTaskList();
