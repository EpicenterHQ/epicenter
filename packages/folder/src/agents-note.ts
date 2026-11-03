/** The root note that names a data folder's published contract. */
import type { Contract } from '@epicenter/definition/contract';
import { agentsContract } from '@epicenter/definition/note';

const BEGIN = '<!-- BEGIN epicenter -->';
const END = '<!-- END epicenter -->';

/** Update only Epicenter's block and a missing front matter contract key. */
export function withAgentsNote(
	current: string | null,
	contract: Contract,
	contractUrl: string,
): string {
	const newline = current?.includes('\r\n') ? '\r\n' : '\n';
	let note = current ?? '';
	const found = agentsContract(note);
	if (found.kind === 'invalid')
		throw new Error(`AGENTS.md has ${found.reason}`);
	if (found.kind === 'frontmatter') {
		if (!found.hasContract)
			note = `${note.slice(0, found.frame.yamlEnd)}contract: ${JSON.stringify(contractUrl)}${found.frame.newline}${note.slice(found.frame.yamlEnd)}`;
	} else
		note = `${found.frame.bom}---${newline}contract: ${JSON.stringify(contractUrl)}${newline}---${newline}${note.slice(found.frame.bom.length)}`;

	const description =
		contract.description?.replace(/\s+/g, ' ').trim() ||
		'This folder holds app data.';
	const collections = Object.entries(contract.collections)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, { path }]) => `${name}: \`${path}\``);
	const groupSize = Math.ceil(collections.length / 3);
	const lines = [description, 'Collections:'];
	for (let index = 0; index < collections.length; index += groupSize)
		lines.push(collections.slice(index, index + groupSize).join('; '));
	lines.push('Check edits with `epicenter check`.');
	const block = `${BEGIN}${newline}${lines.join(newline)}${newline}${END}${newline}`;
	const begins = [
		...note.matchAll(/^<!-- BEGIN epicenter -->[ \t]*(?:\r?\n|$)/gm),
	];
	const ends = [...note.matchAll(/^<!-- END epicenter -->[ \t]*(?:\r?\n|$)/gm)];
	if (
		(begins.length === 0 && ends.length > 0) ||
		(begins.length > 0 && ends.length === 0)
	)
		throw new Error('AGENTS.md has incomplete Epicenter markers');
	if (begins.length > 1 || ends.length > 1) {
		const start = begins[0]?.index ?? -1;
		const last = ends.at(-1)?.index ?? -1;
		if (last < (begins.at(-1)?.index ?? -1))
			throw new Error('AGENTS.md has Epicenter markers out of order');
		return `${note.slice(0, start)}${block.slice(0, -newline.length)}${note.slice(last + END.length)}`;
	}
	if (begins.length === 1) {
		const start = begins[0]?.index ?? -1;
		const end = ends[0]?.index ?? -1;
		if (end < start)
			throw new Error('AGENTS.md has Epicenter markers out of order');
		const contentStart = start + (begins[0]?.[0].length ?? 0);
		return `${note.slice(0, contentStart)}${lines.join(newline)}${newline}${note.slice(end)}`;
	}
	return `${note}${note === '' || note.endsWith('\n') ? '' : newline}${block}`;
}
