/**
 * Handle Type Tests
 *
 * The handle types are the app API's main promise: IntelliSense shows each
 * template's parameter object and each schema's fields. These checks compile
 * under `tsc`; each `@ts-expect-error` fails the typecheck if the error it
 * expects goes away.
 *
 * Key behaviors:
 * - A missing segment and an unknown segment are type errors
 * - A wrong field type is a type error
 * - A template without segments takes no parameters
 * - Note handles have no `put`; batch handles have no reads
 */
import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { type BatchHandles, defineApp, type Handles } from './define.js';
import type { Params } from './templates.js';

const app = defineApp({
	tasks: {
		path: 'projects/{project}/tasks/{stem}.md',
		schema: Type.Object({ title: Type.String(), done: Type.Boolean() }),
	},
	settings: { path: 'settings.md', schema: Type.Object({ theme: Type.String() }) },
	photos: { path: 'photos/{stem}.png', blob: { types: ['image/png'] } },
});
type Defs = typeof app.definitions;

// Never called: the bodies exist for the type checker.
function typeChecks(repo: Handles<Defs>, batch: BatchHandles<Defs>) {
	const params: Params<'projects/{project}/tasks/{stem}.md'> = { project: 'a', stem: 'b' };
	repo.tasks.get(params);
	void repo.tasks.get({ project: 'acme', stem: 'fix-login' }).then((note) => note?.fields.done);
	repo.tasks.live({ project: 'acme' });
	void repo.tasks.open({ project: 'acme', stem: 'fix-login' }).then((note) => note.set('done', true));
	// @ts-expect-error a missing segment is a type error
	repo.tasks.get({ project: 'acme' });
	// @ts-expect-error an unknown segment is a type error
	repo.tasks.get({ project: 'acme', stem: 'x', extra: 'y' });
	repo.tasks.write({ project: 'a', stem: 'b' }, { fields: { done: true } });
	// @ts-expect-error a wrong field type is a type error
	repo.tasks.write({ project: 'a', stem: 'b' }, { fields: { done: 'yes' } });
	// @ts-expect-error set checks the value against the field
	repo.tasks.set({ project: 'a', stem: 'b' }, 'title', 3);
	repo.tasks.list({ project: 'acme' });

	repo.settings.get();
	repo.settings.set('theme', 'dark');
	// @ts-expect-error a template without segments takes no parameters
	repo.settings.get({ stem: 'x' });

	repo.photos.put({ stem: 'p' }, new Uint8Array(), { type: 'image/png' });
	// @ts-expect-error note handles have no put
	repo.tasks.put({ project: 'a', stem: 'b' }, new Uint8Array(), { type: 'image/png' });
	// @ts-expect-error blob handles have no set
	repo.photos.set({ stem: 'p' }, 'x', 1);

	batch.tasks.create({ project: 'a', stem: 'b' }, { fields: { title: 'T', done: false } });
	batch.photos.put({ stem: 'p' }, new Uint8Array(), { type: 'image/png' });
	// @ts-expect-error no reads inside a batch
	batch.tasks.get({ project: 'a', stem: 'b' });
	// @ts-expect-error no reads inside a batch
	batch.photos.list();
}

test('the type checks compile (run by tsc)', () => {
	expect(typeof typeChecks).toBe('function');
});
