/** Pure parsing for the agentskills.io SKILL.md representation. */

import { isJsonObject, type JsonObject } from '@epicenter/app/definition';
import { InstantString } from '@epicenter/app/field';
import { parse as parseYaml } from 'yaml';

function splitFrontmatter(content: string) {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: content };

	const [, yamlString, body] = match as [string, string, string];
	const parsed: unknown = parseYaml(yamlString);
	const frontmatter =
		parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	return { frontmatter, body: body.trimStart() };
}

/** Parse one SKILL.md without assigning canonical record identity. */
export function parseSkillMd(name: string, content: string) {
	const { frontmatter, body } = splitFrontmatter(content);
	let sourceId: string | undefined;
	let metadata: JsonObject | undefined;

	if (
		frontmatter.metadata !== null &&
		typeof frontmatter.metadata === 'object' &&
		!Array.isArray(frontmatter.metadata)
	) {
		const { id, ...rest } = frontmatter.metadata as Record<string, unknown>;
		if (
			typeof id === 'string' &&
			id.length > 0 &&
			id.trim() === id &&
			!id.includes(':')
		) {
			sourceId = id;
		}
		// Gated here rather than left to the store's write gate, so a value that
		// cannot be stored is dropped from the import instead of failing it: YAML
		// admits dates, `Infinity` and cyclic anchors, and none belong in a row.
		if (isJsonObject(rest) && Object.keys(rest).length > 0) metadata = rest;
	}

	return {
		skill: {
			sourceId,
			name,
			description: String(frontmatter.description ?? ''),
			...(typeof frontmatter.license === 'string' && {
				license: frontmatter.license,
			}),
			...(typeof frontmatter.compatibility === 'string' && {
				compatibility: frontmatter.compatibility,
			}),
			...(metadata && { metadata }),
			...(typeof frontmatter['allowed-tools'] === 'string' && {
				allowedTools: frontmatter['allowed-tools'],
			}),
			updatedAt: InstantString.now(),
		},
		instructions: body,
	};
}

export type ParsedSkill = ReturnType<typeof parseSkillMd>['skill'];
