/** Regenerate editor completion from the runtime format definition. */
import { DeclarationSchema } from '../declaration-schema.js';

await Bun.write(
	new URL('../../epicenter.schema.json', import.meta.url),
	`${JSON.stringify(DeclarationSchema, null, 2)}\n`,
);
