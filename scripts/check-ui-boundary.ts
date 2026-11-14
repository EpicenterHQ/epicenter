import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

type Violation = {
	rule: string;
	file: string;
	line: number;
	text: string;
};

const uiSourceRoot = 'packages/ui/src';
const workspaceRoots = ['apps', 'programs', 'sites', 'packages'];
const boundaryConfigFilePatterns = [
	/^package\.json$/,
	/^svelte\.config\.[cm]?[jt]s$/,
	/^vite\.config\.[cm]?[jt]s$/,
	/^wxt\.config\.[cm]?[jt]s$/,
	/^tsconfig(?:\.[\w-]+)?\.json$/,
];
const sourceExtensions = ['.ts', '.js', '.svelte'];
const ignoredDirectories = new Set(['node_modules', '.svelte-kit', '.wxt']);
const uiPrivateImportPattern =
	/^\s*import(?:\s+type)?(?:\s+[^'"]*\s+from)?\s+['"]#(?:['"]|\/|ui|utils|hooks|lib)|\bimport\s*\(\s*['"]#(?:['"]|\/|ui|utils|hooks|lib)/;
const uiSelfPackageImportPattern =
	/^\s*import(?:\s+type)?(?:\s+[^'"]*\s+from)?\s+['"]@epicenter\/ui\/|\bimport\s*\(\s*['"]@epicenter\/ui\//;
const uiSourcePathPattern = /packages\/ui\/src/;
const privateUiConfigPattern = /["']#(?:\/\*|ui|utils|hooks|lib)/;
const consumerUiSourceImportPattern =
	/^\s*import(?:\s+type)?(?:\s+[^'"]*\s+from)?\s+['"][^'"]*packages\/ui\/src|\bimport\s*\(\s*['"][^'"]*packages\/ui\/src/;
const consumerPrivateUiImportPattern =
	/^\s*import(?:\s+type)?(?:\s+[^'"]*\s+from)?\s+['"]#(?:ui|utils|hooks|lib)(?:\/|\.js|['"])|\bimport\s*\(\s*['"]#(?:ui|utils|hooks|lib)(?:\/|\.js|['"])/;

const violations: Violation[] = [];

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (ignoredDirectories.has(entry)) {
			continue;
		}

		const path = join(dir, entry);
		const stats = statSync(path);
		if (stats.isDirectory()) {
			yield* walk(path);
		} else {
			yield path;
		}
	}
}

function hasExtension(file: string, extensions: string[]) {
	return extensions.some((extension) => file.endsWith(extension));
}

function isBoundaryConfigFile(file: string) {
	return boundaryConfigFilePatterns.some((pattern) =>
		pattern.test(basename(file)),
	);
}

function isUiSourceFile(file: string) {
	return file === uiSourceRoot || file.startsWith(`${uiSourceRoot}/`);
}

function shouldCheckFile(file: string) {
	return (
		isUiSourceFile(file) ||
		hasExtension(file, sourceExtensions) ||
		isBoundaryConfigFile(file)
	);
}

function addViolation(rule: string, file: string, line: number, text: string) {
	violations.push({
		rule,
		file,
		line,
		text: text.trim(),
	});
}

function checkLine(file: string, line: string, lineNumber: number) {
	const isUiSource = isUiSourceFile(file);
	const isSource = hasExtension(file, sourceExtensions);
	const isConfig = isBoundaryConfigFile(file);

	if (isUiSource && uiPrivateImportPattern.test(line)) {
		addViolation('UI source must use relative imports', file, lineNumber, line);
	}

	if (isUiSource && uiSelfPackageImportPattern.test(line)) {
		addViolation(
			'UI source must not self-import through @epicenter/ui',
			file,
			lineNumber,
			line,
		);
	}

	if (isConfig && uiSourcePathPattern.test(line)) {
		addViolation(
			'Config must not point at packages/ui/src',
			file,
			lineNumber,
			line,
		);
	}

	if (isConfig && privateUiConfigPattern.test(line)) {
		addViolation(
			'Config must not define private UI imports',
			file,
			lineNumber,
			line,
		);
	}

	if (!isUiSource && isSource && consumerUiSourceImportPattern.test(line)) {
		addViolation(
			'Consumers must not import packages/ui/src directly',
			file,
			lineNumber,
			line,
		);
	}

	if (!isUiSource && isSource && consumerPrivateUiImportPattern.test(line)) {
		addViolation(
			'Consumers must not import UI private import names',
			file,
			lineNumber,
			line,
		);
	}
}

for (const root of workspaceRoots) {
	for (const file of walk(root)) {
		if (!shouldCheckFile(file)) {
			continue;
		}

		const lines = readFileSync(file, 'utf8').split('\n');
		for (const [index, line] of lines.entries()) {
			checkLine(file, line, index + 1);
		}
	}
}

if (violations.length > 0) {
	console.error('UI boundary check failed:');
	for (const violation of violations) {
		console.error(
			`${relative(process.cwd(), violation.file)}:${violation.line}: ${violation.rule}: ${violation.text}`,
		);
	}
	process.exitCode = 1;
}
