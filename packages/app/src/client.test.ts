import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ok } from 'wellcrafted/result';
import { defineAction, type Update } from './action.ts';
import { connect } from './client.ts';
import { createHandler } from './command/serve.ts';
import { defineData } from './data.ts';
import { defineEpicenter } from './epicenter.ts';
import { ActionError } from './errors.ts';
import { field } from './field.ts';

/** A home's epicenter.ts, as one module would write it. */
const folder = await mkdtemp(join(tmpdir(), 'epicenter-client-'));
const data = defineData(folder, {
	watches: {
		description: 'trip idea',
		fields: { to: field.text(), nights: field.integer({ optional: true }) },
	},
});

type Data = typeof data;

function flights({ watches }: Data) {
	const idea = defineAction({
		description: 'One trip idea',
		input: { id: field.text() },
		async run({ id }) {
			const { data: found, error } = await watches.get(id);
			if (error) return ActionError.Refused({ message: error.message });
			if (!found) return ActionError.Missing({ path: `data/watches/${id}.md` });
			// @ts-expect-error: watches has no field price, so typecheck fails.
			found.price;
			return Ok({ to: found.to, nights: found.nights });
		},
	});
	const add = defineAction({
		description: 'Add a trip idea',
		input: { id: field.text(), to: field.text() },
		async run({ id, to }, update: Update<{ step: string }>) {
			update({ step: 'writing' });
			return watches.create(id, { to });
		},
	});
	return { description: 'Trip ideas', actions: { idea, add } };
}

const home = defineEpicenter({ apps: { flights: flights(data) } });

const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	fetch: createHandler({ folder, port: 0 }, { apps: home.apps }),
});
afterAll(async () => {
	await server.stop(true);
	await rm(folder, { recursive: true, force: true });
});

const epicenter = connect<typeof home>({ url: server.url.href });

test('a page calls an action by property, hearing its updates, and gets a Result', async () => {
	const steps: string[] = [];
	const added = await epicenter.flights.add(
		{ id: 'tokyo', to: 'Tokyo' },
		{ onUpdate: ({ step }) => steps.push(step) },
	);
	expect(steps).toEqual(['writing']);
	expect(added.data?.to).toBe('Tokyo');
	const idea = await epicenter.flights.idea({ id: 'tokyo' });
	// The JSON form: an absent optional field is absent, not undefined.
	expect(idea).toEqual(Ok({ to: 'Tokyo' }));
	const missing = await epicenter.flights.idea({ id: 'osaka' });
	expect(missing.error?.name).toBe('Missing');
});

test('serve refusing the input reaches the page as NotStarted', async () => {
	// @ts-expect-error: idea needs an id.
	const refused = await epicenter.flights.idea({});
	expect(refused.error?.name).toBe('NotStarted');
});

test('the client and its apps are never thenable, so awaiting them is safe', async () => {
	expect((epicenter as unknown as { then?: unknown }).then).toBeUndefined();
	expect(
		(epicenter.flights as unknown as { then?: unknown }).then,
	).toBeUndefined();
	expect(await epicenter).toBe(epicenter);
	expect(await epicenter.flights).toBe(epicenter.flights);
});

test('nothing listening is NotStarted', async () => {
	const nowhere = connect<typeof home>({ url: 'http://127.0.0.1:9/' });
	expect((await nowhere.flights.idea({ id: 'x' })).error?.name).toBe(
		'NotStarted',
	);
});

/** Types only: these calls are checked, never run. */
export function typed() {
	// @ts-expect-error: there is no app named trains.
	epicenter.trains;
	// @ts-expect-error: flights has no action named delete.
	epicenter.flights.delete;
	// @ts-expect-error: to is text.
	void epicenter.flights.add({ id: 'x', to: 3 });
	void epicenter.flights.idea({ id: 'x' }).then(({ data, error }) => {
		if (error) {
			const name:
				| 'Refused'
				| 'Missing'
				| 'NotStarted'
				| 'Threw'
				| 'Unreachable' = error.name;
			return name;
		}
		const nights: number | undefined = data.nights;
		return nights;
	});
}
