/**
 * Design B's property test, run over any world: in memory
 * (`b.property.test.ts`) or over the real wire (`b.wire.property.test.ts`).
 *
 * Three people and one agent edit a few notes over a lossy, reordering
 * network whose messages sometimes stall past a request's timeout, through
 * seeded random steps: typing in the body and the frontmatter, breaking and
 * repairing frontmatter, setting one field from several devices, a stale
 * editor buffer saved late, a note too large to store, renames (delete plus
 * write), deletes, deleting a path and creating it again (sometimes with the
 * very text it had before), agent commits (fast-forward, sometimes merge),
 * lost replies, offline periods, restarts, flushes, a device whose storage
 * is lost for good, and a hostile member writing directly to the server.
 * Then everyone comes online, repairs and saves what they hold back, and the
 * network goes quiet.
 *
 * Every step is a word token (`t<n>z`), so the test can say exactly what was
 * typed. A token is *owed* once a person saved it on their device, or once
 * the server applied an agent write holding it. It is *acknowledged* once a
 * commit holding it was answered applied or merged. It stops being owed when
 * a person removes a copy of it from what their editor showed and saved
 * (deleting the word, the file, or overwriting the field; a rename moves it):
 * a deliberate removal, whoever typed it. Notices hold no values: a value
 * counts only where the server or a device keeps it as text.
 *
 * Key behaviors:
 * - An acknowledged token is in a server text after every step, and at quiescence every owed token is
 * - Before it is acknowledged, a token is in a server text or on a surviving device; a lost device loses only what was never acknowledged
 * - A person's removal (a delete, or a rename's old path) makes the path absent on the server, by their commit or another's, unless it lost to an edit by someone else that it had not seen: then the edited file stays, and nothing typed is lost
 * - No stale edit merges silently across a delete: if the path was deleted, or created by someone else, since the commit's parent, the edit lands whole in a conflict block
 * - Every server Markdown file parses and is at most 1 MB; hostile writes (forged author, non-member, oversized, unparseable, replayed id with other files, a flood of stale-parent commits) are refused or bounded
 * - At quiescence every device's mine and base equal the server's text for every path
 *
 * Each suite reads its own environment, by prefix (B for the memory
 * suite, W for the wire): <P>_SEED=n replays one sequence, <P>_RUNS=n runs n
 * seeds from <P>_FROM (default 1), <P>_STEPS=n sets the steps per seed.
 * A failure names its seed and the steps.
 */
import { expect, test } from 'bun:test';
import { parses, splitMarkdown, writeMarkdown } from '../core/markdown.js';
import type { MemoryGitStore } from '../server/memory-git.js';
import type { Server } from '../server/server.js';
import { type Device, type World, createWorld } from './harness.js';
import { escapeLines } from '../core/conflict.js';
import { createRandom } from './net.js';
import { commitId, type LiveCommit } from '../core/commit.js';
import { MAIN } from '../server/git-store.js';
import type { Committed, PushAnswer } from '../server/server.js';

/**
 * What the property test needs of a world: the memory harness's surface,
 * with virtual time stepped asynchronously so a world doing real I/O can
 * finish it between events.
 */
export type PropertyWorld = {
	server: Server;
	git: MemoryGitStore;
	device: World['device'];
	session: World['session'];
	flush: World['flush'];
	calm: World['calm'];
	onCommit: World['onCommit'];
	onRequest: World['onRequest'];
	counts(): Record<string, number>;
	/** Virtual time, in ms. */
	now(): number;
	runFor(ms: number): Promise<void>;
	/** Run until nothing is left to do; false if it never went idle. */
	settle(): Promise<boolean>;
	close(): Promise<void>;
};
export type WorldOptions = NonNullable<Parameters<typeof createWorld>[0]>;

/** The memory harness as a property world. */
export const memoryWorld = (options: WorldOptions): PropertyWorld => {
	const world = createWorld(options);
	return {
		...world,
		now: world.net.now,
		runFor: async (ms) => world.net.runFor(ms),
		settle: async () => world.settle(),
		close: async () => {},
	};
};

const PATHS = ['notes/a.md', 'notes/b.md', 'notes/c.md'];
/** A note created from a template: the same text each time, so a path can hold a new note with an old note's text. */
const TEMPLATE = '---\ntitle: New\n---\n';
const TOKEN = /t\d+z/g;
/** Filler that makes a note larger than the 1 MB a note may be. */
const FILLER = `big ${'x'.repeat(1_100_000)}`;
/** `hasFiller(text)` is pathologically slow in JavaScriptCore on a long text of x's, so look for it this way. */
const hasFiller = (text: string) => /x{1000}/.test(text);
/** Pushes a member makes in one burst; the server's admission limit must hold a flood below the bound. */
const FLOOD = 60;
const FLOOD_BOUND = 30;

const tokensIn = (text: string | null) => new Set(text?.match(TOKEN) ?? []);
const counts = (texts: (string | null)[]) => {
	const out = new Map<string, number>();
	for (const text of texts) for (const t of text?.match(TOKEN) ?? []) out.set(t, (out.get(t) ?? 0) + 1);
	return out;
};

/** Make a text parse and fit without losing a token: close the quotes this test opens, drop the filler, then move frontmatter lines that still fail into the body. */
function repair(text: string) {
	let fixed = text.replaceAll(': "open\n', ': "shut"\n').replace(/x{1000,}/g, '');
	for (let guard = 0; !parses(fixed) && guard < 200; guard++) {
		const { yaml, bodyStart } = splitMarkdown(fixed);
		if (yaml === null) break;
		const lines = yaml.split('\n').filter((line) => line !== '');
		const moved = lines.pop() ?? '';
		fixed = `---\n${lines.map((l) => `${l}\n`).join('')}---\n${moved}\n${fixed.slice(bodyStart)}`;
	}
	return fixed;
}

async function run(seed: number, makeWorld: (options: WorldOptions) => PropertyWorld | Promise<PropertyWorld>, STEPS: number) {
	const random = createRandom(seed * 7919 + 13);
	const log: string[] = [];
	const tracing = process.env.B_TRACE !== undefined;
	const world = await makeWorld({
		seed,
		latency: { min: 5, max: 120 },
		loss: { up: 0.05, down: 0.08 },
		streamLoss: 0.04,
		stall: { chance: 0.03, ms: 4_000 },
		timeout: 1_500,
		...(tracing ? { trace: (line: string) => log.push(line) } : {}),
	});
	const people = ['alice', 'bob', 'carol'].map((name) => world.device(name));
	const agent = world.device('agent', { mode: 'fast-forward' });
	const everyone: Device[] = [...people, agent];
	/** Owed tokens, with who typed them. */
	const owed = new Map<string, string>();
	const acknowledged = new Set<string>();
	const removed = new Set<string>();
	/** Typed on a device lost before its commit was acknowledged: legitimately gone. */
	const forgotten = new Set<string>();
	const removals: { device: string; path: string; base: string | null; position: string | null; at: number; landed: boolean; cancelled: boolean; step: string }[] = [];
	const violations: string[] = [];
	const honestIds: string[] = [];
	let next = 1;
	const token = () => `t${next++}z`;

	// The test's own copy of history: each commit's files, to judge merges independently of the server.
	const states = new Map<string, Map<string, string>>([[world.server.main(), new Map()]]);
	const chain: string[] = [world.server.main()];
	/** Who wrote each commit on the chain, and the paths it changed. */
	const writers: { user: string; paths: Set<string> }[] = [{ user: '', paths: new Set() }];
	let lastMerge: Committed | null = null;
	world.onCommit((committed) => {
		const state = new Map(states.get(committed.parents[0] ?? '') ?? []);
		for (const file of committed.files) {
			if (file.path.endsWith('.md') && file.after !== null && !parses(file.after))
				violations.push(`server: ${file.path} does not parse after a commit by ${committed.author.user}`);
			if (file.after !== null && file.after.length > 1024 * 1024) violations.push(`server: ${file.path} is ${file.after.length} bytes`);
			if (committed.author.user === 'agent') for (const t of tokensIn(file.after)) if (!tokensIn(file.before).has(t)) owed.set(t, 'agent');
			// A removal is done once its path is absent on the server after it, whoever's commit did it.
			if (file.after === null) for (const r of removals) if (r.path === file.path && !r.cancelled) r.landed = true;
			if (file.after === null) state.delete(file.path);
			else state.set(file.path, file.after);
		}
		states.set(committed.id, state);
		chain.push(committed.id);
		writers.push({ user: committed.author.user, paths: new Set(committed.files.map((f) => f.path)) });
		lastMerge = committed.parents.length > 1 ? committed : null;
	});
	world.onRequest((device, request, reply) => {
		if (request.type !== 'push' || reply.type !== 'answer') return;
		const answer = reply.answer as PushAnswer;
		if (answer.kind !== 'applied' && answer.kind !== 'merged') return;
		const commit = request.commit;
		honestIds.push(commit.id);
		for (const file of commit.files) for (const t of tokensIn(file.text)) acknowledged.add(t);
		// No silent merge across a delete, judged by the test's own history.
		const merge = lastMerge as Committed | null;
		if (answer.kind !== 'merged' || merge === null || merge.parents[1] !== commit.id) return;
		const from = chain.indexOf(commit.parent);
		const before = chain.indexOf(merge.parents[0] ?? '');
		for (const file of commit.files) {
			if (file.text === null || from < 0 || before < 0) continue;
			const then = states.get(commit.parent)?.get(file.path) ?? null;
			const ours = states.get(chain[before] ?? '')?.get(file.path) ?? null;
			let deleted = false;
			for (let i = from + 1; i <= before; i++) if (!states.get(chain[i] ?? '')?.has(file.path)) deleted = true;
			// Two creates of the same text (two notes from the template) are one text: nothing to keep apart.
			const other = ours !== null && ours !== file.text && (then === null || deleted);
			const after = states.get(merge.id)?.get(file.path) ?? '';
			// Inside a block, delimiter-like lines of the incoming note are escaped.
			if (other && !(after.includes('<<<<<<< ') && after.includes(escapeLines(file.text.trimEnd()))))
				violations.push(`server: ${device}'s edit of ${file.path} merged silently into another note (${then === null ? 'two creates' : 'deleted since its parent'})`);
		}
	});

	/** A person saves texts. `seen` is what their editor showed (default: what the device shows now). */
	const save = (d: Device, changes: Record<string, string | null>, typed: string[], seen?: Record<string, string | null>, { editor = seen !== undefined } = {}) => {
		const paths = Object.keys(changes);
		const showed = (path: string) => (seen === undefined ? d.replica.read(path) : (seen[path] ?? null));
		const before = counts(paths.map(showed));
		const written = counts(Object.values(changes));
		for (const [t, n] of before) if ((written.get(t) ?? 0) < n) removed.add(t);
		for (const t of typed) if (written.has(t)) owed.set(t, d.name);
		for (const [path, text] of Object.entries(changes)) {
			for (const r of removals) if (r.device === d.name && r.path === path && text !== null) r.cancelled = true;
			// A removal claims a note the device had from the server, not one it created and never sent,
			const known = d.replica.files().get(path)?.base ?? null;
			if (text === null && showed(path) !== null && known !== null)
				removals.push({
					device: d.name,
					path,
					base: known,
					position: d.replica.position(),
					at: chain.length,
					landed: world.server.read(path) === null,
					cancelled: false,
					step: log.at(-1) ?? '',
				});
		}
		d.replica.writeAll(changes, editor && seen !== undefined ? { over: seen } : {});
	};

	const serverText = () => [...world.server.snapshot().values()].join('\n');
	const deviceText = () => everyone.flatMap((d) => [...d.replica.files().values()].map((f) => f.mine ?? '')).join('\n');
	/** Every device's files, their state and position, and the server's main, for a traced failure. */
	const dump = () =>
		[
			`server main ${world.server.main()}`,
			...everyone.map((d) =>
				[
					`${d.name} at ${d.replica.position()}${d.replica.busy() ? ' (busy)' : ''}`,
					...[...d.replica.files()].map(
						([path, f]) =>
							`  ${path} ${JSON.stringify(d.replica.state(path))}${f.settled ? '' : ' unsettled'}\n    base ${JSON.stringify(f.base?.slice(0, 300))}\n    mine ${JSON.stringify(f.mine?.slice(0, 300))}\n    tip  ${JSON.stringify(f.tip?.slice(0, 300))}`,
					),
				].join('\n'),
			),
		].join('\n');
	const check = (step: string, quiet: boolean) => {
		const server = serverText();
		const devices = quiet ? '' : deviceText();
		for (const t of acknowledged)
			if (!removed.has(t) && owed.has(t) && !server.includes(t)) violations.push(`${step}: acknowledged ${t} (${owed.get(t)}) is in no server text`);
		for (const [t, who] of owed)
			if (!removed.has(t) && !forgotten.has(t) && !server.includes(t) && (quiet || !devices.includes(t))) violations.push(`${step}: lost ${t} (${who})`);
		if (violations.length > 0) throw new Error(`seed ${seed}\n${[...new Set(violations)].join('\n')}\n--- steps\n${log.join('\n')}${tracing ? `\n--- devices\n${dump()}` : ''}`);
	};

	/** An editor buffer each person opened and has not saved yet. */
	const editors = new Map<string, { path: string; text: string }>();

	// A hostile member writing straight to the server, and a stranger.
	const hostile = (member: string, files: LiveCommit['files'], { author = member, parent = world.server.main(), id }: { author?: string; parent?: string; id?: string } = {}) => {
		const body = { parent, mode: 'merge' as const, author: { user: author, device: 'x' }, time: 't', files };
		const commit = { id: id ?? commitId(body), ...body };
		return world.server.push(commit, world.session(member));
	};
	const accepted = (answer: PushAnswer) => answer.kind === 'applied' || answer.kind === 'merged';
	const hostileSteps: (() => string)[] = [
		() => {
			if (accepted(hostile('mallory', [{ path: random.pick(PATHS), text: '---\ntitle: forged\n---\nforged\n' }], { author: 'alice' })))
				violations.push('server: accepted a commit whose author is not the session');
			return 'mallory forges alice as author';
		},
		() => {
			if (accepted(hostile('eve', [{ path: 'notes/eve.md', text: '---\ntitle: eve\n---\n' }]))) violations.push('server: accepted a commit from a non-member');
			return 'eve, not a member, pushes';
		},
		() => {
			if (accepted(hostile('mallory', [{ path: 'notes/m.md', text: `---\ntitle: m\n---\n${FILLER}\n` }]))) violations.push('server: accepted a note larger than 1 MB');
			return 'mallory pushes an oversized note';
		},
		() => {
			if (accepted(hostile('mallory', [{ path: 'notes/m.md', text: '---\ntitle: [\n---\nbroken\n' }]))) violations.push('server: accepted a note that does not parse');
			return 'mallory pushes a note that does not parse';
		},
		() => {
			// Appended to what is there, so it removes nothing a person typed.
			const path = random.pick(PATHS);
			const text = world.server.read(path) ?? '---\ntitle: forged\n---\n';
			hostile('mallory', [{ path, text: `${text}${text.endsWith('\n') ? '' : '\n'}<<<<<<< main (alice/laptop)\nI approve\n||||||| base\n=======\nI do not\n>>>>>>> bob/phone\n` }]);
			return 'mallory writes forged conflict labels';
		},
		() => {
			const id = honestIds.length === 0 ? undefined : random.pick(honestIds);
			if (id !== undefined && accepted(hostile('mallory', [{ path: random.pick(PATHS), text: '---\ntitle: replay\n---\nreplayed\n' }], { id })))
				violations.push('server: a replayed id with other files was accepted');
			return 'mallory replays an id with other files';
		},
		() => {
			const path = random.pick(PATHS);
			let landed = 0;
			for (let i = 0; i < FLOOD; i++)
				if (accepted(hostile('mallory', [{ path, text: `---\ntitle: flood\n---\nflood ${i}\n` }], { parent: chain[0] ?? '' }))) landed++;
			if (landed > FLOOD_BOUND) violations.push(`server: ${landed} of a flood of ${FLOOD} stale-parent commits were accepted`);
			return `mallory floods ${path} with stale-parent commits`;
		},
	];

	const steps: [number, (d: Device) => string | null | Promise<string | null>][] = [
		// Type a word into the body, or create the note.
		[
			6,
			(d) => {
				const path = random.pick(PATHS);
				const text = d.replica.read(path);
				const t = token();
				if (text === null) {
					save(d, { [path]: `---\ntitle: ${t}\n---\n` }, [t]);
					return `${d.name} creates ${path} (${t})`;
				}
				const { bodyStart } = splitMarkdown(text);
				const lines = text.slice(bodyStart).split('\n');
				const at = random.int(0, lines.length - 1);
				if (random.chance(0.5)) lines.splice(at, 1, `${lines[at] ?? ''} ${t}`.trim());
				else lines.splice(at, 0, t);
				save(d, { [path]: text.slice(0, bodyStart) + lines.join('\n') }, [t]);
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
				save(d, { [path]: written.data }, [t]);
				return `${d.name} sets mood ${t} in ${path}`;
			},
		],
		// Open an editor on a note, or save the one opened earlier with a word typed: the buffer may be stale.
		[
			2,
			(d) => {
				const open = editors.get(d.name);
				if (open === undefined) {
					const path = random.pick(PATHS);
					const text = d.replica.read(path);
					if (text === null || !parses(text)) return null;
					editors.set(d.name, { path, text });
					return `${d.name} opens an editor on ${path}`;
				}
				editors.delete(d.name);
				const t = token();
				save(d, { [open.path]: `${open.text}${open.text.endsWith('\n') ? '' : '\n'}${t}\n` }, [t], { [open.path]: open.text });
				return `${d.name} saves an editor buffer on ${open.path} with ${t}`;
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
				save(d, { [path]: `---\nx${t}: "open\n${text.slice(4)}` }, [t]);
				return `${d.name} breaks ${path} (${t})`;
			},
		],
		// Paste far too much into a note.
		[
			1,
			(d) => {
				const path = random.pick(PATHS);
				const text = d.replica.read(path);
				if (text === null || hasFiller(text)) return null;
				const t = token();
				save(d, { [path]: `${text}${text.endsWith('\n') ? '' : '\n'}${t} ${FILLER}\n` }, [t]);
				return `${d.name} pastes more than 1 MB into ${path} (${t})`;
			},
		],
		// Repair what does not parse or does not fit.
		[
			2,
			(d) => {
				const path = random.pick(PATHS);
				const text = d.replica.read(path);
				if (text === null || (parses(text) && !hasFiller(text))) return null;
				save(d, { [path]: repair(text) }, []);
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
				save(d, { [path]: text.replace(new RegExp(` ?${word}`), '') }, []);
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
				save(d, { [from]: null, [to]: text }, []);
				return `${d.name} renames ${from} to ${to}`;
			},
		],
		// Delete a note.
		[
			1,
			(d) => {
				const path = random.pick(PATHS);
				if (d.replica.read(path) === null) return null;
				save(d, { [path]: null }, []);
				return `${d.name} deletes ${path}`;
			},
		],
		// Delete a note and create its path again at once, often from the template.
		[
			1,
			async (d) => {
				const path = random.pick(PATHS);
				if (d.replica.read(path) === null) return null;
				save(d, { [path]: null }, []);
				await world.runFor(random.int(0, 400));
				if (d.replica.read(path) !== null) return `${d.name} deletes ${path}, which came back`;
				const t = token();
				const fresh = random.chance(0.5) ? TEMPLATE : `---\ntitle: ${t}\n---\n`;
				save(d, { [path]: fresh }, [t]);
				return `${d.name} deletes and re-creates ${path}${fresh === TEMPLATE ? ' from the template' : ` (${t})`}`;
			},
		],
		[1, (d) => (d.setOnline(!d.isOnline()), `${d.name} goes ${d.isOnline() ? 'online' : 'offline'}`)],
		[1, (d) => (d.loseNextReply(), `${d.name} will lose its next reply`)],
		[1, (d) => (d.restart(), `${d.name} restarts`)],
		[1, () => (world.flush(), 'the server flushes')],
		[
			1,
			async (d) => {
				d.loseNextReply();
				await world.runFor(random.int(50, 400));
				world.flush();
				return `${d.name} loses a reply, and the server flushes`;
			},
		],
		// The device's storage is lost for good: what it never had acknowledged is gone with it.
		[
			1,
			(d) => {
				for (const [t, who] of owed) if (who === d.name && !acknowledged.has(t)) forgotten.add(t);
				for (const r of removals) if (r.device === d.name && !r.landed) r.cancelled = true;
				editors.delete(d.name);
				d.lose();
				return `${d.name} loses its storage`;
			},
		],
		[1, () => random.pick(hostileSteps)()],
	];
	const total = steps.reduce((sum, [weight]) => sum + weight, 0);

	const agentStep = () => {
		const path = random.pick(PATHS);
		const text = agent.replica.read(path);
		if (text === null) return null;
		const t = token();
		const commitMode = random.chance(0.3) ? 'merge' : 'fast-forward';
		agent.replica.write(path, `${text}${text.endsWith('\n') ? '' : '\n'}agent ${t}\n`, { commitMode });
		return `agent appends ${t} to ${path} (${commitMode})`;
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
					said = await act(d);
					break;
				}
			}
		}
		if (said !== null) log.push(`${world.now()} ${n}: ${said}`);
		await world.runFor(random.int(0, 300));
		check(`after step ${n}`, false);
	}

	// Quiescence: everyone online; each person repairs what does not parse or fit, and saves what they hold.
	world.calm();
	for (const d of everyone) d.setOnline(true);
	for (let round = 0; round < 6; round++) {
		if (!(await world.settle())) throw new Error(`seed ${seed}: never went idle\n${log.join('\n')}`);
		let saved = false;
		for (const d of people) {
			const held = new Map(d.replica.held().map((h) => [h.path, h.reason]));
			for (const path of new Set([...d.replica.paths(), ...held.keys()])) {
				const text = d.replica.read(path);
				const reason = held.get(path);
				if (text === null) continue;
				// Too many blocks: the person resolves them by keeping every side's lines, which removes nothing typed.
				const unblocked = reason === 'the note has too many conflict blocks' ? text.split('\n').filter((line) => !/^(<<<<<<< |\|\|\|\|\|\|\| base$|=======$|>>>>>>> )/.test(line)).join('\n') : text;
				const fixed = parses(unblocked) && !hasFiller(unblocked) ? unblocked : repair(unblocked);
				if (fixed === text && text === world.server.read(path) && reason === undefined) continue;
				save(d, { [path]: fixed }, []);
				log.push(`quiet: ${d.name} saves ${path}${reason === undefined ? '' : ` (${reason})`}`);
				saved = true;
			}
		}
		if (!saved) break;
	}
	await world.settle();
	check('at quiescence', true);
	const server = world.server.snapshot();
	for (const d of everyone) {
		if (d.replica.busy()) violations.push(`quiet: ${d.name} is still busy`);
		const files = d.replica.files();
		for (const path of new Set([...server.keys(), ...files.keys()])) {
			const file = files.get(path);
			const want = server.get(path) ?? null;
			if ((file !== undefined && !file.settled) || (file?.mine ?? null) !== want || (file?.base ?? null) !== want)
				violations.push(
					`quiet: ${d.name} ${path}: mine ${JSON.stringify(file?.mine?.slice(0, 200))} base ${JSON.stringify(file?.base?.slice(0, 200))} server ${JSON.stringify(want?.slice(0, 200))}`,
				);
		}
	}
	// A removal stays removed, unless it lost to an edit by someone else made after the text it removed (which it had not seen).
	const lostToEdit = (r: (typeof removals)[number]) => {
		// Everything after the remover's position is unseen by it; the text alone cannot say where that is, since an edit can bring a path back to the text it had.
		let from = r.position === null ? -1 : chain.indexOf(r.position);
		if (from < 0) for (from = r.at - 1; from > 0 && (states.get(chain[from] ?? '')?.get(r.path) ?? null) !== r.base; ) from--;
		return writers.slice(from + 1).some((w) => w.user !== r.device && w.paths.has(r.path));
	};
	for (const r of removals)
		if (!r.cancelled && !r.landed && server.has(r.path) && !lostToEdit(r))
			violations.push(`quiet: ${r.device}'s removal of ${r.path} (${r.step}) never took effect, and no edit it had not seen beat it`);
	check('at quiescence', true);
	const notices: Record<string, number> = {};
	for (const line of log) {
		const reason = /^quiet: \w+ saves \S+ \(([^)]+)\)/.exec(line)?.[1];
		if (reason === undefined) continue;
		const key = `held: ${reason}`;
		notices[key] = (notices[key] ?? 0) + 1;
	}
	const stats: Record<string, number> = {};
	for (const d of everyone) for (const [key, value] of Object.entries(d.replica.stats())) stats[key] = (stats[key] ?? 0) + value;
	const conflicts = [...server.values()].filter((text) => text?.includes('<<<<<<< ')).length;
	return { world, requests: world.counts(), notices, stats, conflicts, agentRefusals: agent.replica.stats().refused };
}

/**
 * Register one test per seed: the run, then, once the last flush is done,
 * Git's main equals the server's main. `prefix` names the suite's
 * environment variables; `runs` is its default number of seeds.
 */
export function definePropertySuite({
	label,
	prefix,
	runs,
	world: makeWorld,
	timeout,
}: {
	label: string;
	prefix: string;
	runs: number;
	world: (options: WorldOptions) => PropertyWorld | Promise<PropertyWorld>;
	timeout?: number;
}) {
	const env = (name: string) => process.env[`${prefix}_${name}`];
	const count = Number(env('RUNS') ?? runs);
	const from = Number(env('FROM') ?? 1);
	const seeds = env('SEED') === undefined ? Array.from({ length: count }, (_, i) => from + i) : [Number(env('SEED'))];
	const steps = Number(env('STEPS') ?? 60);
	const totals: Record<string, number> = {};
	const add = (key: string, n: number) => {
		totals[key] = (totals[key] ?? 0) + n;
	};

	for (const seed of seeds)
		test(
			`${label} keeps every invariant under seed ${seed}`,
			async () => {
				let opened: PropertyWorld | undefined;
				try {
					const result = await run(seed, async (options) => (opened = await makeWorld(options)), steps);
					const { world } = result;
					expect(result.requests.push).toBeGreaterThan(0);
					// Flushes ran on their schedule during the run; once the last is done, Git's main is the server's main.
					await world.server.idle();
					await world.flush();
					const head = await world.git.readRef(MAIN);
					const tree = head === null ? new Map() : await world.git.readTree((await world.git.readCommit(head))?.tree ?? '');
					const decoder = new TextDecoder();
					const inGit = new Map<string, string>();
					for (const [path, entry] of tree) if (path !== '.gitattributes') inGit.set(path, decoder.decode((await world.git.readBlob(entry.oid)) ?? new Uint8Array()));
					expect(inGit).toEqual(world.server.snapshot());
					for (const [key, n] of Object.entries({ ...result.requests, ...result.stats })) add(key, n);
					for (const [kind, n] of Object.entries(result.notices)) add(`notice:${kind}`, n);
					add('conflicted files', result.conflicts);
					add('agent refusals', result.agentRefusals);
				} finally {
					await opened?.close();
				}
			},
			timeout,
		);

	if (env('TOTALS') !== undefined) test(`${label}: totals`, () => console.log(totals));
}
