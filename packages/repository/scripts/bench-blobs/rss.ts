/** The resident memory of a process and every process below it, sampled with `ps`. */

/** Bytes resident in `pid` and its descendants now. */
export async function treeRss(pid: number): Promise<number> {
	const out = await new Response(
		Bun.spawn(['ps', '-A', '-o', 'pid=,ppid=,rss=']).stdout,
	).text();
	const rows = out
		.trim()
		.split('\n')
		.map(
			(line) =>
				line.trim().split(/\s+/).map(Number) as [number, number, number],
		);
	const tree = new Set([pid]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const [child, parent] of rows)
			if (tree.has(parent) && !tree.has(child)) {
				tree.add(child);
				grew = true;
			}
	}
	return rows
		.filter(([child]) => tree.has(child))
		.reduce((sum, [, , rss]) => sum + rss * 1024, 0);
}

/** Bytes resident in every process whose arguments match `pattern`. */
export async function matchingRss(pattern: RegExp): Promise<number> {
	const out = await new Response(
		Bun.spawn(['ps', '-A', '-o', 'rss=,args=']).stdout,
	).text();
	return out
		.trim()
		.split('\n')
		.map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
		.filter((match) => match !== null && pattern.test(match[2] ?? ''))
		.reduce((sum, match) => sum + Number(match?.[1] ?? 0) * 1024, 0);
}

/** Run `work`, sampling resident memory (`rss`) every 50 ms: its result, and the peak above `idle`. */
export async function peakAbove<T>(
	rss: () => Promise<number>,
	idle: number,
	work: () => Promise<T>,
) {
	let peak = 0;
	let running = true;
	const sampling = (async () => {
		while (running) {
			peak = Math.max(peak, (await rss()) - idle);
			await Bun.sleep(50);
		}
	})();
	const result = await work();
	running = false;
	await sampling;
	return { result, peak };
}

/** The browser process launched on `profile`: the one whose arguments name it and whose parent does not. */
export async function profileRoot(profile: string): Promise<number> {
	const out = await new Response(
		Bun.spawn(['ps', '-A', '-o', 'pid=,ppid=,args=']).stdout,
	).text();
	const rows = out
		.trim()
		.split('\n')
		.map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
		.filter((match) => match !== null)
		.map(([, pid, ppid, args]) => ({
			pid: Number(pid),
			ppid: Number(ppid),
			args: args ?? '',
		}));
	const naming = rows.filter((row) => row.args.includes(profile));
	const root = naming.find(
		(row) => !naming.some((other) => other.pid === row.ppid),
	);
	if (root === undefined)
		throw new Error(`No browser process names ${profile}`);
	return root.pid;
}
