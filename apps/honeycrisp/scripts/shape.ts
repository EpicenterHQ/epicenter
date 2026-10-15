#!/usr/bin/env bun
/**
 * Write `shape.json`, the declaration of the shape Honeycrisp opens, which
 * `epicenter.app.json` names as `opens` (ADR-0538, ADR-0540). Epicenter reads
 * it to offer Honeycrisp on a folder without building or running Honeycrisp.
 * Run it after changing `src/lib/data.ts`; `shape.test.ts` fails until then.
 */
import { join } from 'node:path';
import { formatDeclaration } from '@epicenter/folder';
import { honeycrispDefinition } from '../src/lib/data.ts';

await Bun.write(
	join(import.meta.dir, '..', 'shape.json'),
	formatDeclaration(honeycrispDefinition),
);
