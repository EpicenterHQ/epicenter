#!/usr/bin/env bun
/** Write epicenter.schema.json from the declaration's TypeBox schema, its one source (ADR-0857). */
import { join } from 'node:path';
import { declarationJsonSchema } from '../src/declaration.ts';

await Bun.write(
	join(import.meta.dir, '..', 'epicenter.schema.json'),
	declarationJsonSchema(),
);
