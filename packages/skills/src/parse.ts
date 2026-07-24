/** Pure parsing for the agentskills.io SKILL.md representation. */

import type { JsonValue } from '@epicenter/data/protocol/v1';
import { InstantString } from '@epicenter/field';
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
	let metadata: Record<string, JsonValue> | undefined;

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

function isJsonObject(
	value: Record<string, unknown>,
): value is Record<string, JsonValue> {
	return Object.values(value).every((child) => isJsonValue(child));
}

function isJsonValue(
	value: unknown,
	ancestors = new Set<object>(),
): value is JsonValue {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return true;
	}
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object' || ancestors.has(value)) return false;
	ancestors.add(value);
	const valid = Array.isArray(value)
		? value.every((child) => isJsonValue(child, ancestors))
		: (Object.getPrototypeOf(value) === Object.prototype ||
				Object.getPrototypeOf(value) === null) &&
			Object.values(value).every((child) => isJsonValue(child, ancestors));
	ancestors.delete(value);
	return valid;
}
