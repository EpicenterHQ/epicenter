#!/usr/bin/env bun
/** Runs the hosted API and the account dashboard together on port 5178. */
import { $ } from 'bun';

const run =
	await $`bun run --filter @epicenter/api --filter @epicenter/api-ui dev`
		.env({ ...process.env, API_PUBLIC_ORIGIN: 'http://localhost:5178' })
		.nothrow();
process.exit(run.exitCode);
