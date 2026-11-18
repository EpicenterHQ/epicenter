/**
 * Hosted-home route policy tests.
 * Each operation requires its declared scope. Unknown routes and the old
 * interruption/static-admin endpoints never reach the private home binding.
 */
import { expect, test } from 'bun:test';
import { homeScope } from './hosted-home.ts';
import {
	homeExperimentEnabled,
	hostedAudiences,
} from './hosted-home-config.ts';

test('source editing, publishing, running, and credential management have distinct scopes', () => {
	expect(homeScope('/admin/source', 'GET')).toBe('home:read');
	expect(homeScope('/admin/source', 'POST')).toBe('home:source');
	expect(homeScope('/admin/build', 'POST')).toBe('home:build');
	expect(homeScope('/.runs/tasks/add/run-1', 'POST')).toBe('home:run');
	expect(
		homeScope('/tasks~revision/.runs/tasks/review/run-1/events', 'GET'),
	).toBe('home:read');
	expect(homeScope('/.runs/tasks/review/run-1/cancel', 'POST')).toBe(
		'home:run',
	);
	expect(homeScope('/agents', 'GET')).toBe('home:manage');
	expect(homeScope('/agents/other-token', 'DELETE')).toBe('home:manage');
});
test('the public gateway refuses platform and unknown routes', () => {
	for (const path of [
		'/admin/interrupt',
		'/admin/static',
		'/platform/template',
		'/homes/other-person',
		'/agents/id/extra',
	])
		for (const method of ['GET', 'POST', 'DELETE'])
			expect(homeScope(path, method)).toBeUndefined();
});
test('a hosted audience belongs to the configured API origin, ignoring its input path', () => {
	expect(hostedAudiences('https://api.epicenter.so/path').homes).toBe(
		'https://api.epicenter.so/homes',
	);
});

test('normal deployments leave hosted homes disabled', () => {
	expect(homeExperimentEnabled({})).toBe(false);
	expect(homeExperimentEnabled({ HOSTED_HOMES_EXPERIMENT: 'off' })).toBe(false);
	expect(homeExperimentEnabled({ HOSTED_HOMES_EXPERIMENT: 'on' })).toBe(true);
});
