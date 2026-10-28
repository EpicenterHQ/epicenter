/**
 * Design B Property Test
 *
 * Three people and one agent edit a few notes over a lossy, reordering
 * network whose messages sometimes stall past a request's timeout, through
 * seeded random steps: typing in the body and the
 * frontmatter, breaking and repairing frontmatter, setting one field from
 * several devices, renames (delete plus write), deletes, deleting a path and
 * creating it again (sometimes with the very text it had before), agent
 * commits (fast-forward, sometimes merge), lost replies, offline periods,
 * restarts and flushes, also between a lost reply and its resend. Then everyone comes
 * online, repairs what they hold back, and the network goes quiet.
 *
 * Every step is a word token (`t<n>z`), so the test can say exactly what was
 * typed. A token is *owed* once a person saved it on their device, or once
 * the server applied an agent write holding it. It stops being owed when a
 * person removes a copy of it from the files one of their saves changes
 * (deleting the word, the file, or overwriting the field; a rename moves it,
 * removing nothing): that is a deliberate removal, whoever typed it. A word
 * shown twice (as in a conflict block's base section) is removed when either
 * copy is deleted, since two people deleting one copy each is no loss. A token is *reachable* when it is a substring of a
 * text the server holds (a note, a sibling, a conflict block inside one) or
 * of a notice on any device; between steps also of any text a device shows.
 *
 * Key behaviors:
 * - Nothing owed is ever unreachable, after any step or at quiescence
 * - No server file ever goes from parsing to not parsing
 * - At quiescence every device's mine and base equal the server's text for every path
 * - Every stale edit is visible: it is in a server text (as merged lines or conflict markers) or a notice, which the first promise checks; a stale edit may land in whatever note is at its path now
 *
 * Set B_SEED=n to replay one sequence, B_RUNS=n to run n seeds from B_FROM (default 1).
 * A failure names its seed and the steps.
 */
import { expect, test } from 'bun:test';
import { parses, splitMarkdown, writeMarkdown } from '../markdown.js';
import { type Device, createWorld } from './harness.js';
import { createRandom } from './net.js';

const RUNS = Number(process.env.B_RUNS ?? 40);
const FROM = Number(process.env.B_FROM ?? 1);
const SEEDS = process.env.B_SEED === undefined ? Array.from({ length: RUNS }, (_, i) => FROM + i) : [Number(process.env.B_SEED)];
const STEPS = Number(process.env.B_STEPS ?? 60);
const PATHS = ['notes/a.md', 'notes/b.md', 'notes/c.md'];
/** A note created from a template: the same text each time, so a path can hold a new note with an old note's text. */
const TEMPLATE = '---\ntitle: New\n---\n';
const TOKEN = /t\d+z/g;

const tokensIn = (text: string | null) => new Set(text?.match(TOKEN) ?? []);

/** Make a text parse without losing anything: close the quotes this test opens, then move frontmatter lines that still fail into the body. */
function repair(text: string) {
	let fixed = text.replaceAll(': "open\n', ': "shut"\n');
	for (let guard = 0; !parses(fixed) && guard < 200; guard++) {
		const { yaml, bodyStart } = splitMarkdown(fixed);
		if (yaml === null) break;
		const lines = yaml.split('\n').filter((line) => line !== '');
		const moved = lines.pop() ?? '';
		fixed = `---\n${lines.map((l) => `${l}\n`).join('')}---\n${moved}\n${fixed.slice(bodyStart)}`;
	}
	return fixed;
}

function run(seed: number) {
	const random = createRandom(seed * 7919 + 13);
	const world = createWorld({
		seed,
		latency: { min: 5, max: 120 },
		loss: { up: 0.05, down: 0.08 },
		streamLoss: 0.04,
		stall: { chance: 0.03, ms: 4_000 },
		timeout: 1_500,
		...(process.env.B_TRACE === undefined ? {} : { trace: (line: string) => log.push(line) }),
	});
	const people = ['alice', 'bob', 'carol'].map((name) => world.device(name));
	const agent = world.device('agent', { mode: 'fast-forward' });
	const everyone: Device[] = [...people, agent];
	const log: string[] = [];
	const owed = new Set<string>();
	const removed = new Set<string>();
	const violations: string[] = [];
	let next = 1;
	const token = () => `t${next++}z`;

	world.onCommit((committed) => {
		for (const file of committed.files) {
			if (file.path.endsWith('.md') && file.before !== null && file.after !== null && parses(file.before) && !parses(file.after))
				violations.push(`server: ${file.path} stopped parsing (by ${committed.author.user})`);
			if (committed.author.user === 'agent') for (const t of tokensIn(file.after)) if (!tokensIn(file.before).has(t)) owed.add(t);
		}
	});

	/** How many times each token appears in the paths given. */
	const shown = (d: Device, paths: string[]) => {
		const counts = new Map<string, number>();
		for (const path of paths) for (const t of d.replica.read(path)?.match(TOKEN) ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
		return counts;
	};
	/** A person changes what they show; what they typed is owed, a token of which they deleted a copy is removed. */
	const edit = (d: Device, changes: Record<string, string | null>, typed: string[]) => {
		const paths = Object.keys(changes);
		const before = shown(d, paths);
		d.replica.write(changes);
		const after = shown(d, paths);
		for (const [t, n] of before) if ((after.get(t) ?? 0) < n) removed.add(t);
		for (const t of typed) if (after.has(t)) owed.add(t);
	};

	const reachable = (quiet: boolean) => {
		const texts: string[] = [...world.server.snapshot().values()];
		for (const d of everyone) {
			texts.push(JSON.stringify(d.replica.notices()));
			if (!quiet) for (const f of d.replica.files().values()) if (f.mine !== null) texts.push(f.mine);
		}
		const all = texts.join('\n');
		return [...owed].filter((t) => !removed.has(t) && !all.includes(t));
	};

	const steps: [number, (d: Device) => string | null][] = [
		// Type a word into the body, or create the note.
		[
			6,
			(d) => {
				const path = random.pick(PATHS);
				const text = d.replica.read(path);
				const t = token();
				if (text === null) {
					edit(d, { [path]: `---\ntitle: ${t}\n---\n` }, [t]);
					return `${d.name} creates ${path} (${t})`;
				}
				const { bodyStart } = splitMarkdown(text);
				const lines = text.slice(bodyStart).split('\n');
				const at = random.int(0, lines.length - 1);
				if (random.chance(0.5)) lines.splice(at, 1, `${lines[at] ?? ''} ${t}`.trim());
				else lines.splice(at, 0, t);
				edit(d, { [path]: text.slice(0, bodyStart) + lines.join('\n') }, [t]);
				return `${d.name} types ${t} in ${path}`;
			},
		],
		// Set one field, which several devices set.
		[
			3,
			(d) => {
				const path = random.pick(PATHS);
				const text = d.replica.read(path);
				if (text === null || !parses(text)) return null;
				const t = token();
				const written = writeMarkdown(text, { fields: { mood: t } });
				if (written.error !== null) return null;
				edit(d, { [path]: written.data }, [t]);
				return `${d.name} sets mood ${t} in ${path}`;
			},
		],
		// Break the frontmatter with a quote left open.
		[
			2,
			(d) => {
				const path = random.pick(PATHS);
				const text = d.replica.read(path);
				if (text === null || !text.startsWith('---\n') || !parses(text)) return null;
				const t = token();
				edit(d, { [path]: `---\nx${t}: "open\n${text.slice(4)}` }, [t]);
				return `${d.name} breaks ${path} (${t})`;
			},
		],
		// Repair what does not parse.
		[
			2,
			(d) => {
				const path = random.pick(PATHS);
				const text = d.replica.read(path);
				if (text === null || parses(text)) return null;
				edit(d, { [path]: repair(text) }, []);
				return `${d.name} repairs ${path}`;
			},
		],
		// Delete a word.
		[
			2,
			(d) => {
				const path = random.pick(PATHS);
				const text = d.replica.read(path);
				const words = [...tokensIn(text)];
				if (text === null || words.length === 0) return null;
				const word = random.pick(words);
				edit(d, { [path]: text.replace(new RegExp(` ?${word}`), '') }, []);
				return `${d.name} deletes the word ${word} in ${path}`;
			},
		],
		// Rename: delete the old path and write the new one, in one write.
		[
			1,
			(d) => {
				const from = random.pick(PATHS);
				const to = random.pick(PATHS);
				const text = d.replica.read(from);
				if (text === null || from === to || d.replica.read(to) !== null) return null;
				edit(d, { [from]: null, [to]: text }, []);
				return `${d.name} renames ${from} to ${to}`;
			},
		],
		// Delete a note.
		[
			1,
			(d) => {
				const path = random.pick(PATHS);
				if (d.replica.read(path) === null) return null;
				edit(d, { [path]: null }, []);
				return `${d.name} deletes ${path}`;
			},
		],
		// Delete a note and create its path again at once, often from the template.
		[
			1,
			(d) => {
				const path = random.pick(PATHS);
				if (d.replica.read(path) === null) return null;
				edit(d, { [path]: null }, []);
				world.net.runFor(random.int(0, 400));
				if (d.replica.read(path) !== null) return `${d.name} deletes ${path}, which came back`;
				const t = token();
				const fresh = random.chance(0.5) ? TEMPLATE : `---\ntitle: ${t}\n---\n`;
				edit(d, { [path]: fresh }, [t]);
				return `${d.name} deletes and re-creates ${path}${fresh === TEMPLATE ? ' from the template' : ` (${t})`}`;
			},
		],
		[1, (d) => (d.setOnline(!d.isOnline()), `${d.name} goes ${d.isOnline() ? 'online' : 'offline'}`)],
		[1, (d) => (d.loseNextReply(), `${d.name} will lose its next reply`)],
		[1, (d) => (d.restart(), `${d.name} restarts`)],
		[1, () => (world.flush(), 'the server flushes')],
		// A reply lost, then a flush before the resend: the outcome is gone, the trailers remain.
		[
			1,
			(d) => {
				d.loseNextReply();
				world.net.runFor(random.int(50, 400));
				world.flush();
				return `${d.name} loses a reply, and the server flushes`;
			},
		],
	];
	const total = steps.reduce((sum, [weight]) => sum + weight, 0);

	const agentStep = () => {
		const path = random.pick(PATHS);
		const text = agent.replica.read(path);
		if (text === null) return null;
		const t = token();
		const commitMode = random.chance(0.3) ? 'merge' : 'fast-forward';
		agent.replica.write({ [path]: `${text}${text.endsWith('\n') ? '' : '\n'}agent ${t}\n` }, { commitMode });
		return `agent appends ${t} to ${path} (${commitMode})`;
	};

	const check = (step: string, quiet: boolean) => {
		const lost = reachable(quiet);
		if (lost.length > 0) violations.push(`${step}: lost ${lost.join(', ')}`);
		if (violations.length > 0) throw new Error(`seed ${seed}\n${violations.join('\n')}\n--- steps\n${log.join('\n')}`);
	};

	for (let n = 0; n < STEPS; n++) {
		let said: string | null = null;
		if (random.chance(0.12)) said = agentStep();
		else {
			let pick = random.int(1, total);
			const d = random.pick(people);
			for (const [weight, act] of steps) {
				pick -= weight;
				if (pick <= 0) {
					said = act(d);
					break;
				}
			}
		}
		if (said !== null) log.push(`${world.net.now()} ${n}: ${said}`);
		world.net.runFor(random.int(0, 300));
		check(`after step ${n}`, false);
	}

	// Quiescence: everyone online, nothing lost, everything held repaired.
	world.calm();
	for (const d of everyone) d.setOnline(true);
	for (let round = 0; round < 6; round++) {
		if (!world.settle()) throw new Error(`seed ${seed}: never went idle\n${log.join('\n')}`);
		let repaired = false;
		for (const d of people)
			for (const path of d.replica.paths()) {
				const text = d.replica.read(path);
				if (text !== null && !parses(text)) {
					edit(d, { [path]: repair(text) }, []);
					log.push(`quiet: ${d.name} repairs ${path}`);
					repaired = true;
				}
			}
		if (!repaired) break;
	}
	world.settle();
	check('at quiescence', true);
	const server = world.server.snapshot();
	for (const d of everyone) {
		if (d.replica.busy()) violations.push(`quiet: ${d.name} is still busy`);
		const files = d.replica.files();
		for (const path of new Set([...server.keys(), ...files.keys()])) {
			const file = files.get(path);
			const want = server.get(path) ?? null;
			if ((file !== undefined && !file.settled) || (file?.mine ?? null) !== want || (file?.base ?? null) !== want)
				violations.push(`quiet: ${d.name} ${path}: mine ${JSON.stringify(file?.mine)} base ${JSON.stringify(file?.base)} server ${JSON.stringify(want)}`);
		}
	}
	check('at quiescence', true);
	const notices: Record<string, number> = {};
	for (const d of everyone) for (const notice of d.replica.notices()) notices[notice.kind] = (notices[notice.kind] ?? 0) + 1;
	const stats: Record<string, number> = {};
	for (const d of everyone) for (const [key, value] of Object.entries(d.replica.stats())) stats[key] = (stats[key] ?? 0) + value;
	const conflicts = [...server.values()].filter((text) => text?.includes('<<<<<<< ')).length;
	const refusedPeople = people.reduce((n, d) => n + d.replica.refusals().length, 0);
	return { requests: world.counts(), notices, stats, conflicts, refusedPeople, agentRefusals: agent.replica.refusals().length };
}

const totals: Record<string, number> = {};
const add = (key: string, n: number) => {
	totals[key] = (totals[key] ?? 0) + n;
};

for (const seed of SEEDS)
	test(`design B keeps every invariant under seed ${seed}`, () => {
		const result = run(seed);
		expect(result.refusedPeople).toBe(0);
		for (const [key, n] of Object.entries({ ...result.requests, ...result.stats })) add(key, n);
		for (const [kind, n] of Object.entries(result.notices)) add(`notice:${kind}`, n);
		add('conflicted files', result.conflicts);
		add('agent refusals', result.agentRefusals);
	});

if (process.env.B_TOTALS !== undefined) test('totals', () => console.log(totals));
