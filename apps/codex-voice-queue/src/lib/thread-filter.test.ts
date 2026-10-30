import { expect, test } from 'bun:test';
import type { ThreadSummary } from './api-types.js';
import {
	matchesThread,
	neighborId,
	projectLabel,
	projectOptions,
} from './thread-filter.js';

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
	return {
		id: 'a',
		title: 'Fix recorder',
		preview: 'Microphone permissions',
		cwd: '/work/epicenter/app',
		gitBranch: 'Voice-Queue',
		source: 'cli',
		createdAt: 1,
		updatedAt: 1,
		status: { type: 'idle' },
		...overrides,
	};
}

test('project labels use the last segment on Unix and Windows paths', () => {
	expect(projectLabel('/work/app/')).toBe('app');
	expect(projectLabel('C:\\work\\app')).toBe('app');
	expect(projectLabel('/')).toBe('/');
	expect(projectLabel('')).toBe('');
});

test('every query term must match a field regardless of case or whitespace', () => {
	expect(
		matchesThread(thread(), {
			query: ' RECORDER  microphone\tEPICENTER voice ',
			project: null,
		}),
	).toBe(true);
	expect(
		matchesThread(thread(), { query: 'recorder missing', project: null }),
	).toBe(false);
	expect(matchesThread(thread(), { query: '   ', project: null })).toBe(true);
	expect(
		matchesThread(thread({ gitBranch: null }), {
			query: 'voice',
			project: null,
		}),
	).toBe(false);
});

test('project filtering uses the exact cwd and composes with search', () => {
	expect(
		matchesThread(thread(), { query: 'fix', project: '/work/epicenter/app' }),
	).toBe(true);
	expect(
		matchesThread(thread(), { query: '', project: '/work/epicenter' }),
	).toBe(false);
	expect(
		matchesThread(thread(), { query: '', project: '/WORK/epicenter/app' }),
	).toBe(false);
});

test('project options count unique cwds, sort by latest update, and disambiguate labels', () => {
	expect(
		projectOptions([
			thread(),
			thread({ updatedAt: 5 }),
			thread({ cwd: '/work/other/app', updatedAt: 3 }),
			thread({ cwd: '/work/tools', updatedAt: 8 }),
		]).map(({ cwd, label, count }) => ({ cwd, label, count })),
	).toEqual([
		{ cwd: '/work/tools', label: 'tools', count: 1 },
		{ cwd: '/work/epicenter/app', label: 'app · epicenter', count: 2 },
		{ cwd: '/work/other/app', label: 'app · other', count: 1 },
	]);
	expect(projectOptions([])).toEqual([]);
});

test('neighbors follow full order when the current thread is filtered out', () => {
	const order = ['a', 'b', 'c', 'd', 'e'];
	const visible = new Set(['a', 'd']);
	expect(neighborId(order, visible, 'c', 1)).toBe('d');
	expect(neighborId(order, visible, 'c', -1)).toBe('a');
	expect(neighborId(order, visible, 'a', 1)).toBe('d');
	expect(neighborId(order, visible, 'd', 1)).toBeNull();
	expect(neighborId(order, visible, 'a', -1)).toBeNull();
	expect(neighborId(order, visible, null, 1)).toBe('a');
	expect(neighborId(order, visible, null, -1)).toBe('d');
	expect(neighborId(order, new Set(), 'c', 1)).toBeNull();
});
