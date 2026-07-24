# @epicenter/skills

`@epicenter/skills` declares an inert Skills Lens and ordinary
services over an already opened handle. The package does not open storage,
construct browser or Node runtimes, expose Yjs GUIDs, or register actions.

```ts
import { listSkills, skillsLens } from '@epicenter/skills';
import { openBunEpicenter } from '@epicenter/data/runtime/bun';

await using epicenter = await openBunEpicenter({
	database: '/app/data/epicenter.sqlite3',
	owner: null,
});
const skills = epicenter.bind(skillsLens);
const { rows, nonconforming } = await skills.skills.scan();
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
const { data: instructions, error } = await skills.skills
	.record(skill.id)
	.document.open();
if (error !== null) throw error;
await using lease = instructions;
const content = lease.getText('content');
lease.transact(() => content.insert(0, '# Instructions'));
await lease.whenDurable();
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
