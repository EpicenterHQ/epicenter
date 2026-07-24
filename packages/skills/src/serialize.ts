/** Pure serialization for the agentskills.io SKILL.md representation. */

import { stringify as stringifyYaml } from 'yaml';
import type { Skill } from './lens.js';

/** Serialize one conforming skill and its collaborative instruction body. */
export function serializeSkillMd(skill: Skill, instructions: string): string {
	const frontmatter = {
		name: skill.name,
		description: skill.description,
		...(skill.license !== undefined && { license: skill.license }),
		...(skill.compatibility !== undefined && {
			compatibility: skill.compatibility,
		}),
		metadata: { ...skill.metadata, id: skill.sourceId },
		...(skill.allowedTools !== undefined && {
			'allowed-tools': skill.allowedTools,
		}),
	};

	return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 })}---\n\n${instructions}`;
}
