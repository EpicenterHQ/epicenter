/** Create a small app in its own repository (ADR-0841). */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nameProblem, SCHEMA_URL } from '@epicenter/app';
import { checkedGit } from './git.ts';
import { homeDir, writeDeclarationTypes } from './home.ts';
import { fail, writeErr, writeJson, writeOut } from './output.ts';

/** `epicenter new <name>`: an app from a template, in its own repository with one commit. */
export async function newCommand(
	name: string | undefined,
	json: boolean,
): Promise<number> {
	const problem = nameProblem(name);
	if (problem !== undefined || name === undefined)
		return fail(
			{ code: 'usage', message: `${problem}, so it cannot name an app` },
			json,
		);
	const home = homeDir();
	await mkdir(home, { recursive: true });
	if (
		(await readdir(home)).some(
			(entry) => entry.toLowerCase() === name.toLowerCase(),
		)
	)
		return fail(
			{ code: 'usage', message: `${name} already exists in ${home}` },
			json,
		);
	const folder = join(home, name);
	await mkdir(folder);
	const declaration = {
		$schema: SCHEMA_URL,
		name,
		description: `Describe ${name}`,
	};
	await writeFile(
		join(folder, 'epicenter.json'),
		`${JSON.stringify(declaration, null, 2)}\n`,
	);
	await writeDeclarationTypes(folder, declaration);
	await writeFile(
		join(folder, 'epicenter.ts'),
		`import declaration from './epicenter.json';
import { defineApp, field } from '@epicenter/app';

export default defineApp(declaration, {
	actions: {
		hello: {
			description: 'Say hello',
			input: { who: field.text({ optional: true }) },
			positional: ['who'],
			annotations: { readOnlyHint: true },
			run: ({ who }) => \`Hello, \${who ?? 'you'}\`,
		},
	},
});
`,
	);
	await writeFile(
		join(folder, 'package.json'),
		`${JSON.stringify(
			{
				name,
				private: true,
				type: 'module',
				dependencies: { '@epicenter/app': 'link:@epicenter/app' },
				devDependencies: { '@types/bun': 'latest' },
			},
			null,
			2,
		)}\n`,
	);
	await writeFile(
		join(folder, '.gitignore'),
		'node_modules/\n.cache/\nepicenter.d.json.ts\n',
	);
	try {
		await checkedGit(folder, 'init');
	} catch (error) {
		return fail(
			{
				code: 'failed',
				message: error instanceof Error ? error.message : String(error),
			},
			json,
		);
	}
	let installed = false;
	if (process.env.EPICENTER_SKIP_INSTALL !== '1') {
		let problem = '';
		try {
			const child = Bun.spawn(['bun', 'install'], {
				cwd: folder,
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			installed = code === 0;
			problem = stderr.trim() || stdout.trim();
		} catch (error) {
			problem = error instanceof Error ? error.message : String(error);
		}
		if (!installed)
			writeErr(
				`bun install failed: ${problem}\nRun bun link once in the Epicenter repository's packages/app, then bun install in ${folder}`,
			);
	}
	try {
		await checkedGit(folder, 'add', '-A');
		await checkedGit(folder, 'commit', '--no-verify', '-m', `new ${name}`);
	} catch (error) {
		return fail(
			{
				code: 'failed',
				message: error instanceof Error ? error.message : String(error),
			},
			json,
		);
	}
	if (json) writeJson({ name, folder, installed });
	else {
		writeOut(folder);
		writeOut(`Next: epicenter ${name} hello`);
	}
	return 0;
}
