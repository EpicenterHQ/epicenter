# @epicenter/skills

`@epicenter/skills` declares inert Skills data definitions and ordinary
services over an already opened handle. The package does not open storage,
construct browser or Node runtimes, expose Yjs GUIDs, or register actions.

```ts
import { openDatabase } from '@epicenter/app/store/browser';
import { skillsDefinition } from '@epicenter/skills';

const { data: skills, error } = await openDatabase(skillsDefinition, {
	appId: 'so.epicenter.skills',
	generation,
	account,
});
if (error !== null) return handle(error);
const rows = skills.tables.skills.rows;
```

## Data model

Skill and reference metadata are canonical JSON rows interpreted by the
release-local workspace declaration. The runtime allocates structural row
ids. A
SKILL.md `metadata.id` is stored separately as `sourceId`, so filesystem
round-trips can match records without forging canonical identity.

Each skill and reference row carries a `content` rich field. A skill's holds its
instructions; a reference's holds its Markdown body:

```ts
const content = skills.tables.skills.get(skill.id)?.content;
content?.insert(0, ['# Instructions']);
```

The field is minted with its row and lives in the same document, so there is
nothing to open, await, or dispose. Callers pass the structural row id they
already own.

Catalog reads return nonconforming diagnostics with the preserved canonical
rows; they never heal user data during reads. A developer repairs a row with
the same typed `update` used for ordinary writes.

## Filesystem portability

The `@epicenter/skills/node` subpath exports `importSkillsFromDisk` and
`exportSkillsToDisk`. Both receive an opened Skills handle. They do not create a
Node-specific Data runtime or own runtime lifecycle.

## License

AGPL-3.0
