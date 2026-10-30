import type { ThreadSummary } from './api-types.js';

export function projectLabel(cwd: string) {
	return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}

export function matchesThread(
	thread: ThreadSummary,
	{ query, project }: { query: string; project: string | null },
) {
	if (project !== null && thread.cwd !== project) return false;
	const fields = [
		thread.title,
		thread.preview,
		thread.cwd,
		thread.gitBranch ?? '',
	].map((value) => value.toLowerCase());
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((term) => fields.some((field) => field.includes(term)));
}

export function projectOptions(threads: Iterable<ThreadSummary>) {
	const projects = new Map<
		string,
		{ cwd: string; label: string; count: number; updatedAt: number }
	>();
	for (const thread of threads) {
		const existing = projects.get(thread.cwd);
		if (existing) {
			existing.count++;
			existing.updatedAt = Math.max(existing.updatedAt, thread.updatedAt);
		} else {
			projects.set(thread.cwd, {
				cwd: thread.cwd,
				label: projectLabel(thread.cwd),
				count: 1,
				updatedAt: thread.updatedAt,
			});
		}
	}
	const labels = new Map<string, number>();
	for (const project of projects.values())
		labels.set(project.label, (labels.get(project.label) ?? 0) + 1);
	return [...projects.values()]
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.map((project) => {
			const parent = project.cwd.split(/[\\/]/).filter(Boolean).at(-2);
			return {
				...project,
				label:
					(labels.get(project.label) ?? 0) > 1 && parent
						? `${project.label} · ${parent}`
						: project.label,
			};
		});
}

export function neighborId(
	order: readonly string[],
	visible: Set<string>,
	fromId: string | null,
	direction: 1 | -1,
) {
	const index =
		fromId === null
			? direction === 1
				? -1
				: order.length
			: order.indexOf(fromId);
	for (let i = index + direction; i >= 0 && i < order.length; i += direction) {
		const id = order[i];
		if (id !== undefined && visible.has(id)) return id;
	}
	return null;
}
