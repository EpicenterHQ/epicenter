/** Desktop SQL reads saved documents without changing the public query contract. */
import { queryDocuments, readDirectoryDocuments } from '@epicenter/folder/bun';
import { EXIT, fail, writeJson } from './output.ts';

export async function documentsQuery(directory: string, json: boolean) {
	const input: unknown = JSON.parse(await Bun.stdin.text());
	if (
		typeof input !== 'object' ||
		input === null ||
		!('sql' in input) ||
		typeof input.sql !== 'string'
	)
		return fail('documents-query reads {"sql": "..."} on stdin', json);
	const reading = await readDirectoryDocuments(directory);
	if (reading.error !== null) return fail(reading.error.message, json);
	const answer = queryDocuments(reading.data, input.sql);
	if (answer.error !== null) return fail(answer.error.message, json);
	writeJson(answer.data);
	return EXIT.ok;
}
