// Builds the fixed platform compiler. This script never reads fixture/tasks.
import { readdir } from 'node:fs/promises';
const result = Bun.spawnSync(
	[
		process.execPath,
		'x',
		'wrangler',
		'deploy',
		'--dry-run',
		'--config',
		'wrangler.compiler.jsonc',
		'--outdir',
		'compiler-artifact',
	],
	{ stdout: 'inherit', stderr: 'inherit' },
);
if (result.exitCode) process.exit(result.exitCode);
const wasm = (await readdir('compiler-artifact')).find((name) =>
	name.endsWith('.wasm'),
)!;
await Bun.write(
	'compiler-artifact/code.txt',
	await Bun.file('compiler-artifact/compiler.js').text(),
);
await Bun.write(
	'compiler-artifact/esbuild.bin',
	Bun.file('compiler-artifact/' + wasm),
);
await Bun.write(
	'compiler-artifact/loader.ts',
	`import code from './code.txt';\nimport wasm from './esbuild.bin';\nexport const compilerCode={mainModule:'compiler.js',modules:{'compiler.js':{js:code},'${wasm}':{wasm}},compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat'],globalOutbound:null};\n`,
);
