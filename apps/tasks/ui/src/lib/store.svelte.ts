/**
 * The task list as the server last gave it, with this page's own writes
 * shown before they land. Everything is asked of `epicenter serve` through
 * the app's actions; nothing is kept on the device.
 */
import { connect } from '@epicenter/app/client';
import type { Task } from './tasks.js';

/** Tasks' actions, asked of the server that serves this UI. */
export const app = connect('tasks');

/** What `tasks get` and `tasks set` answer: a task's fields, id, and notes. */
export type TaskFile = Task & { body: string };

function createTaskList() {
	let rows = $state.raw<Task[]>([]);
	let loaded = $state(false);
	let problem = $state<string>();
	/** Done changes sent and not yet answered, by id, shown over the server's rows. */
	let pending = $state.raw(new Map<string, boolean>());
	/** Counts writes, so a list asked for before a write does not undo it on screen. */
	let writes = 0;

	function replace(id: string, change: (task: Task) => Task | undefined) {
		rows = rows.flatMap((task) => {
			if (task.id !== id) return [task];
			const next = change(task);
			return next ? [next] : [];
		});
	}

	async function refresh() {
		const before = writes;
		try {
			const next = await app.call<Task[]>('tasks list');
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
				pending.has(task.id) ? { ...task, done: pending.get(task.id) as boolean } : task,
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
			const task = await app.call<Task>('add', { title });
			rows = [...rows.filter((row) => row.id !== task.id), task];
			return task;
		},

		/** Mark `id` done or not, shown at once and undone on screen if the write fails. */
		async setDone(id: string, done: boolean) {
			writes++;
			pending = new Map(pending).set(id, done);
			try {
				const file = await app.call<TaskFile>('tasks set', { id, done });
				replace(id, (task) => ({ ...task, done: file.done }));
			} finally {
				const next = new Map(pending);
				next.delete(id);
				pending = next;
			}
		},

		/** Note what `tasks set` answered for a task changed elsewhere in the UI. */
		changed(file: TaskFile) {
			writes++;
			const { body: _, ...task } = file;
			replace(file.id, () => task);
		},

		/** Delete `id`; it leaves the list at once. */
		async remove(id: string) {
			writes++;
			replace(id, () => undefined);
			await app.call<boolean>('tasks delete', { id });
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
