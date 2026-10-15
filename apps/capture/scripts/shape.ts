#!/usr/bin/env bun
/**
 * Write `shape.json`, the declaration of the shape Capture opens, which
 * `epicenter.app.json` names as `opens` (ADR-0538, ADR-0540). Epicenter reads
 * it to offer Capture on a folder without building or running Capture. Run it
 * after changing `captureDefinition` in `packages/capture/src/definition.ts`;
 * `shape.test.ts` fails until then.
 */
import { join } from 'node:path';
import { captureDefinition } from '@epicenter/capture';
import { formatDeclaration } from '@epicenter/folder';

await Bun.write(
	join(import.meta.dir, '..', 'shape.json'),
	formatDeclaration(captureDefinition),
);
