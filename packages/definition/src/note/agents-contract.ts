/** Read only the contract key of a folder's AGENTS.md front matter. */
import { isMap, isScalar, parseDocument } from 'yaml';
import { frameRowText } from './frame.js';

export function agentsContract(text: string) {
	const frame = frameRowText(text);
	if (frame.kind === 'missing') return { kind: 'missing' as const, frame };
	if (frame.kind === 'unclosed')
		return { kind: 'invalid' as const, reason: 'unclosed front matter' };
	const document = parseDocument(text.slice(frame.yamlStart, frame.yamlEnd), {
		uniqueKeys: true,
		version: '1.2',
	});
	const problem = document.errors[0];
	if (problem !== undefined)
		return { kind: 'invalid' as const, reason: problem.message };
	if (document.contents !== null && !isMap(document.contents))
		return {
			kind: 'invalid' as const,
			reason: 'front matter is not a mapping',
		};
	const pair = document.contents?.items.find(
		({ key }) => isScalar(key) && key.value === 'contract',
	);
	return {
		kind: 'frontmatter' as const,
		frame,
		hasContract: pair !== undefined,
		contract: isScalar(pair?.value) ? pair.value.value : undefined,
	};
}
