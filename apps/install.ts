/**
 * `bun apps/install.ts <app>`: puts the app `apps/<app>` into
 * `~/Epicenter/<app>`. `HOME` decides `~`, so a test points it at a
 * temporary folder.
 *
 * The first install makes the app with `epicenter new <app>`. Every install
 * copies `epicenter.json` and `epicenter.ts`, when there is one, and commits
 * them alone as `install <app>`; it builds the view for `/<app>/`, where
 * `epicenter serve` mounts it, into the app's `views/`, which the app's
 * `.gitignore` keeps out of its history: the view is built from here, and only
 * the computer that serves it needs it. The app's data is never touched.
 */
import {
	appendFileSync,
	cpSync,
	existsSync,
	readFileSync,
	rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

const app = process.argv[2];
if (!app || !/^[a-z0-9-]+$/.test(app)) {
	console.error('Usage: bun apps/install.ts <app>');
	process.exit(2);
}
const source = join(import.meta.dir, app);
const target = join(homedir(), 'Epicenter', app);
const cli = join(import.meta.dir, '..', 'packages', 'cli', 'src', 'bin.ts');

if (!existsSync(join(source, 'epicenter.json'))) {
	console.error(`There is no ${join(source, 'epicenter.json')}`);
	process.exit(2);
}
if (!existsSync(target)) await $`bun ${cli} new ${app}`;

const ignore = join(target, '.gitignore');
const ignored = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
if (!ignored.split('\n').includes('views/'))
	appendFileSync(ignore, `${ignored === '' || ignored.endsWith('\n') ? '' : '\n'}views/\n`);

const paths = ['.gitignore', 'epicenter.json'];
cpSync(join(source, 'epicenter.json'), join(target, 'epicenter.json'));
if (existsSync(join(source, 'epicenter.ts'))) {
	cpSync(join(source, 'epicenter.ts'), join(target, 'epicenter.ts'));
	paths.push('epicenter.ts');
}
await $`git add -- ${paths}`.cwd(target);
const staged = await $`git diff --cached --quiet -- ${paths}`.cwd(target).nothrow();
if (staged.exitCode !== 0)
	await $`git commit -q -m ${`install ${app}`} -- ${paths}`.cwd(target);

await $`bun run build`.cwd(source).env({ ...process.env, VIEW_BASE: `/${app}` });
rmSync(join(target, 'views'), { recursive: true, force: true });
cpSync(join(source, 'build'), join(target, 'views'), { recursive: true });
console.log(target);
