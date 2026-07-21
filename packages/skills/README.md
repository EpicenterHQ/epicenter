# @epicenter/skills

`@epicenter/skills` declares inert Skills data definitions and ordinary
services over an already opened handle. The package does not open storage,
construct browser or Node runtimes, expose Yjs GUIDs, or register actions.

```ts
import {
	listSkills,
	skillsDefinitions,
} from '@epicenter/skills';
import { openBunEpicenter } from '@epicenter/data/bun';

await using epicenter = await openBunEpicenter({
	path: '/app/data/epicenter.sqlite3',
});
const skills = epicenter.bind(skillsDefinitions);
const catalog = await listSkills(skills);
```

## Data model

Skill and reference metadata are canonical JSON rows interpreted by the
release-local table lenses. The runtime allocates structural row ids. A
SKILL.md `metadata.id` is stored separately as `sourceId`, so filesystem
round-trips can match records without forging canonical identity.

Each skill and reference row owns one document. The skill document stores its
instructions; the reference document stores its Markdown body:

```ts
await using instructions = await skills.tables.skills.openDocument(skill.id);
const content = instructions.get('content');
instructions.transact(() => content.insert(0, '# Instructions'));
await instructions.whenDurable();
```

The runtime derives persistence and synchronization from the row address.
Callers pass the structural row id they already own.

Catalog reads return nonconforming diagnostics with the preserved canonical
rows; they never heal user data during reads. A developer repairs a row with
the same typed `update` used for ordinary writes.

## Filesystem portability

The `@epicenter/skills/node` subpath exports `importSkillsFromDisk` and
`exportSkillsToDisk`. Both receive an opened Skills handle. They do not create a
Node-specific Data runtime or own runtime lifecycle.

## License

AGPL-3.0
