#!/usr/bin/env bun
/**
 * Write `shape.json`, the declaration of the shape Todos opens, which
 * `epicenter.app.json` names as `opens` (ADR-0538, ADR-0540). Epicenter reads
 * it to offer Todos on a folder without building or running Todos. Run it
 * after changing `src/lib/definition.ts`; `shape.test.ts` fails until then.
 */
import { join } from 'node:path';
import { formatDeclaration } from '@epicenter/folder';
import { todosDefinition } from '../src/lib/definition.ts';

await Bun.write(
	join(import.meta.dir, '..', 'shape.json'),
	formatDeclaration(todosDefinition),
);
