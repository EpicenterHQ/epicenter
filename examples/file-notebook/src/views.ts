import {
	type DataDefinition,
	defineStore,
	defineTable,
	field,
} from '@epicenter/app';
import { rowFile } from '@epicenter/app/artifact/format';
import { compileData } from '@epicenter/app/definition';
import {
	applyEdits,
	type Node as JsonNode,
	modify,
	type ParseError,
	parseTree,
} from 'jsonc-parser';
import { isMap, isScalar, parseDocument } from 'yaml';
import {
	type AccountFiles,
	checkedPath,
	type FileSnapshot,
	rowStem,
	sameRowId,
} from './files.js';

export const notesDefinition = defineStore({
	id: 'so.epicenter.demo.notes',
	kv: { weather: field.string() },
	tables: { notes: defineTable({ fields: { title: field.string() } }) },
});

export const filesDefinition = defineStore({
	id: 'so.epicenter.demo.files',
	kv: {},
	tables: { files: defineTable({ fields: { caption: field.string() } }) },
});

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decode(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

function markdown(source: FileSnapshot) {
	const text = decode(source.bytes);
	const match = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---|---)([\s\S]*)$/.exec(
		text,
	);
	if (!match) throw new Error('Markdown frontmatter is missing or malformed');
	const [, opening, yaml, closing, body] = match;
	if (
		opening === undefined ||
		yaml === undefined ||
		closing === undefined ||
		body === undefined
	)
		throw new Error('Markdown framing is malformed');
	const document = parseDocument(yaml, { uniqueKeys: true, strict: true });
	if (document.errors.length || !isMap(document.contents))
		throw new Error('Markdown fields cannot be interpreted');
	const fields = document.toJS();
	if (!fields || typeof fields !== 'object' || Array.isArray(fields))
		throw new Error('Markdown fields must be an object');
	return {
		text,
		opening,
		yaml,
		closing,
		body,
		fields: fields as Record<string, unknown>,
		document,
	};
}

export function openFileStore(definition: DataDefinition, files: AccountFiles) {
	const compiled = compileData(definition);
	if (compiled.error) throw compiled.error;
	const folder = definition.id;
	return {
		async rows(table: string) {
			const declared = compiled.data.tables.get(table);
			if (!declared) throw new Error(`Unknown table: ${table}`);
			const allPaths = await files.list();
			const paths = allPaths.filter(
				(path) =>
					path.startsWith(`${folder}/${table}/`) && path.endsWith('.md'),
			);
			const identities = new Map<string, string[]>();
			for (const path of paths) {
				const id = sameRowId(path);
				if (!id) continue;
				const group = identities.get(id) ?? [];
				group.push(path);
				identities.set(id, group);
			}
			return Promise.all(
				paths.map(async (path) => {
					const source = await files.read(path);
					if (!source) return { path, error: 'Disappeared while reading' };
					try {
						const parsed = markdown(source);
						const identity = sameRowId(path);
						if (identity && (identities.get(identity)?.length ?? 0) > 1)
							throw new Error('Duplicate row ID');
						if (
							table === 'files' &&
							allPaths.filter(
								(candidate) =>
									candidate
										.toLowerCase()
										.startsWith(`${rowStem(path).toLowerCase()}.`) &&
									candidate !== path,
							).length > 1
						) {
							throw new Error('File row has multiple same-stem attachments');
						}
						const conformance = declared.conformance(parsed.fields as never);
						return {
							path,
							source,
							fields: conformance.conforming,
							body: parsed.body,
							issues: conformance.issues,
						};
					} catch (error) {
						return {
							path,
							source,
							error: error instanceof Error ? error.message : String(error),
						};
					}
				}),
			);
		},
		async createRow(
			table: string,
			rowPath: string,
			values: Record<string, unknown>,
			body: string,
			attachment?: { path: string; bytes: Uint8Array },
		) {
			if (
				!compiled.data.tables.has(table) ||
				!rowPath.startsWith(`${folder}/${table}/`) ||
				!sameRowId(rowPath)
			)
				throw new Error('Invalid row path');
			const bytes = encoder.encode(rowFile(values as never, body));
			await files.publishRow(rowPath, bytes, attachment);
		},
		async setField(source: FileSnapshot, fieldName: string, value: string) {
			const parsed = markdown(source);
			if (!isMap(parsed.document.contents))
				throw new Error('Markdown fields cannot be interpreted');
			const row = source.path.slice(folder.length + 1).split('/');
			const declared = compiled.data.tables.get(row[0] ?? '');
			if (
				!source.path.startsWith(`${folder}/`) ||
				!declared?.fields.has(fieldName)
			)
				throw new Error('Field is not declared');
			if (typeof parsed.fields[fieldName] !== 'string')
				throw new Error('Typed edit requires an existing string field');
			const pair = parsed.document.contents?.items.find(
				(item) => isScalar(item.key) && item.key.value === fieldName,
			);
			if (
				!pair ||
				!isScalar(pair.value) ||
				typeof pair.value.value !== 'string'
			)
				throw new Error('Field is not a scalar string');
			const range = pair.value.range;
			if (
				!range ||
				pair.value.anchor ||
				parsed.yaml.slice(range[0], range[1]).includes('\n')
			)
				throw new Error('Field source cannot be patched safely');
			const editedYaml = `${parsed.yaml.slice(0, range[0])}${JSON.stringify(value)}${parsed.yaml.slice(range[1])}`;
			const edited = `${parsed.opening}${editedYaml}${parsed.closing}${parsed.body}`;
			const checked = markdown({ ...source, bytes: encoder.encode(edited) });
			if (
				checked.fields[fieldName] !== value ||
				checked.body !== parsed.body ||
				Object.entries(parsed.fields).some(
					([key, previous]) =>
						key !== fieldName &&
						JSON.stringify(checked.fields[key]) !== JSON.stringify(previous),
				)
			) {
				throw new Error('Field patch changed other source');
			}
			return files.replace(source, encoder.encode(edited));
		},
		async kv() {
			const source = await files.read(`${folder}/kv.json`);
			if (!source)
				return { values: {} as Record<string, unknown>, source: undefined };
			const values = parseKv(decode(source.bytes));
			return { values: values as Record<string, unknown>, source };
		},
		async setKv(key: string, value: string) {
			if (!compiled.data.kv.fields.has(key))
				throw new Error('Setting is not declared');
			const source = await files.read(`${folder}/kv.json`);
			if (!source)
				return files.create(
					`${folder}/kv.json`,
					encoder.encode(`${JSON.stringify({ [key]: value }, null, 2)}\n`),
				);
			const original = decode(source.bytes);
			parseKv(original);
			const edited = applyEdits(original, modify(original, [key], value, {}));
			parseKv(edited);
			return files.replace(source, encoder.encode(edited));
		},
	};
}

function parseKv(text: string): Record<string, unknown> {
	const errors: ParseError[] = [];
	const root = parseTree(text, errors, {
		disallowComments: true,
		allowTrailingComma: false,
	});
	if (errors.length || root?.type !== 'object')
		throw new Error('kv.json must be a JSON object');
	const names = new Set<string>();
	for (const property of root.children ?? ([] as JsonNode[])) {
		const key = property.children?.[0]?.value;
		if (typeof key !== 'string' || names.has(key))
			throw new Error('kv.json has duplicate or invalid keys');
		names.add(key);
	}
	return JSON.parse(text) as Record<string, unknown>;
}

export function notePath(id: string, label: string): string {
	return checkedPath(`${notesDefinition.id}/notes/${id}~${label}.md`);
}

export function photoPath(id: string, label: string): string {
	return checkedPath(`${filesDefinition.id}/files/${id}~${label}.md`);
}
