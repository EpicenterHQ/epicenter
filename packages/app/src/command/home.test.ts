import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findHome } from './home.ts';

const folders: string[] = [];
afterEach(async () => {
	for (const folder of folders.splice(0))
		await rm(folder, { recursive: true, force: true });
});

async function home(marker: unknown) {
	const folder = await realpath(
		await mkdtemp(join(tmpdir(), 'epicenter-home-')),
	);
	folders.push(folder);
	await writeFile(join(folder, 'package.json'), JSON.stringify(marker));
	return folder;
}

test('the home is the nearest package.json with an epicenter key, walking past one without', async () => {
	const folder = await home({ private: true, epicenter: { port: 4747 } });
	const app = join(folder, 'apps', 'flights');
	await mkdir(app, { recursive: true });
	await writeFile(join(app, 'package.json'), '{"name":"flights"}');
	expect(findHome(app).data).toEqual({ folder, port: 4747 });
});

test('a marker without a port it can use is refused', async () => {
	const folder = await home({ epicenter: { port: 'soon' } });
	expect(findHome(folder).error?.message).toContain('"epicenter" needs a port');
});

test('no marker above is refused', () => {
	expect(findHome('/').error?.message).toContain(
		'no package.json with an "epicenter" key',
	);
});

test('a package.json that is not JSON is refused, not walked past to an outer home', async () => {
	const folder = await home({ epicenter: { port: 4747 } });
	const inner = join(folder, 'other');
	await mkdir(inner);
	await writeFile(join(inner, 'package.json'), '{ "epicenter": ');
	expect(findHome(inner).error?.message).toContain('is not JSON');
});
