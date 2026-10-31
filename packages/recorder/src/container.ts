/**
 * What the recorder reads in the audio files it writes: how long one plays
 * (`audioDurationMs`), and where one a quit or a closed tab cut off ends
 * cleanly (`repairAudio`).
 *
 * - WAV (the desktop's): the header names the length.
 * - AAC in fragmented MP4 (`m4a`, a browser's first choice): `ftyp` and
 *   `moov`, then one `moof` and `mdat` per piece the browser handed over. A
 *   file cut off ends inside a box, or with a `moof` whose `mdat` never
 *   came; it is whole up to the last `mdat` that is.
 * - Opus in WebM (`webm`): a segment and clusters of unknown size, so blocks
 *   can be added forever. A file cut off ends inside an element; it is whole
 *   up to the last element that is.
 *
 * Both browser formats are written in pieces of about a second, and every
 * piece but the last cut is whole, so a repair loses at most that piece.
 * Nothing here decodes audio.
 */

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
	String.fromCharCode(...bytes.subarray(offset, offset + length));

const viewOf = (bytes: Uint8Array) =>
	new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * The play length of an audio file the recorder writes (`wav`, `m4a`,
 * `webm`), read from its own bytes, or undefined when they do not read as
 * that format. A file a quit cut off reads up to its last whole piece.
 */
export function audioDurationMs(
	bytes: Uint8Array,
	ext: string,
): number | undefined {
	switch (ext.toLowerCase()) {
		case 'wav':
			return wavDurationMs(bytes);
		case 'm4a':
		case 'mp4':
			return mp4DurationMs(bytes);
		case 'webm':
			return webmDurationMs(bytes);
		default:
			return undefined;
	}
}

/**
 * The bytes of a browser recording (`m4a` or `webm`) a quit or a closed tab
 * cut off, up to its last whole piece, so every player reads it to the end.
 * Undefined when nothing needs cutting, or when what is there is not the
 * format, or too little of it to play: such a file is left as it is.
 */
export function repairAudio(
	bytes: Uint8Array,
	ext: string,
): Uint8Array | undefined {
	switch (ext.toLowerCase()) {
		case 'm4a':
		case 'mp4':
			return repairMp4(bytes);
		case 'webm':
			return repairWebm(bytes);
		default:
			return undefined;
	}
}

// --- WAV --------------------------------------------------------------------

/** The play length of PCM WAV bytes, or undefined when they are not readable WAV. */
function wavDurationMs(bytes: Uint8Array): number | undefined {
	if (
		bytes.length < 12 ||
		ascii(bytes, 0, 4) !== 'RIFF' ||
		ascii(bytes, 8, 4) !== 'WAVE'
	)
		return undefined;
	const view = viewOf(bytes);
	let byteRate: number | undefined;
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const id = ascii(bytes, offset, 4);
		const size = view.getUint32(offset + 4, true);
		if (id === 'fmt ' && offset + 20 <= bytes.length)
			byteRate = view.getUint32(offset + 16, true);
		if (id === 'data') {
			if (byteRate === undefined || byteRate === 0) return undefined;
			const length = Math.min(size, bytes.length - offset - 8);
			return Math.round((length / byteRate) * 1000);
		}
		offset += 8 + size + (size % 2);
	}
	return undefined;
}

// --- MP4 --------------------------------------------------------------------

type Box = {
	readonly type: string;
	/** Where its contents start. */
	readonly body: number;
	/** Where it ends. */
	readonly end: number;
};

/**
 * The whole boxes between `start` and `end`, in order, stopping at the
 * first that is not whole (or does not read as a box).
 */
function boxesIn(bytes: Uint8Array, start: number, end: number): Box[] {
	const view = viewOf(bytes);
	const boxes: Box[] = [];
	let offset = start;
	while (offset + 8 <= end) {
		let size = view.getUint32(offset);
		let header = 8;
		if (size === 1) {
			if (offset + 16 > end) break;
			size = Number(view.getBigUint64(offset + 8));
			header = 16;
		} else if (size === 0) size = end - offset;
		if (size < header || offset + size > end) break;
		boxes.push({
			type: ascii(bytes, offset + 4, 4),
			body: offset + header,
			end: offset + size,
		});
		offset += size;
	}
	return boxes;
}

const childOf = (bytes: Uint8Array, box: Box | undefined, type: string) =>
	box && boxesIn(bytes, box.body, box.end).find((child) => child.type === type);

/**
 * Where a fragmented MP4 is whole: after its last `mdat`, or after `moov`
 * when no fragment is whole yet. Undefined when it has no `moov`.
 */
function mp4WholeEnd(bytes: Uint8Array): number | undefined {
	const boxes = boxesIn(bytes, 0, bytes.length);
	if (boxes[0]?.type !== 'ftyp') return undefined;
	const moov = boxes.find((box) => box.type === 'moov');
	if (moov === undefined) return undefined;
	let whole = moov.end;
	for (const box of boxes)
		if (box.type === 'mdat' && box.end > whole) whole = box.end;
	// A file whose every box is whole and ends with no `moof` waiting for its `mdat`.
	const last = boxes.at(-1);
	if (last !== undefined && last.end === bytes.length && last.type !== 'moof')
		return bytes.length;
	return whole;
}

function repairMp4(bytes: Uint8Array): Uint8Array | undefined {
	const whole = mp4WholeEnd(bytes);
	if (whole === undefined || whole === bytes.length) return undefined;
	return bytes.slice(0, whole);
}

/** A full box's version, and where its fields start. */
const fullBox = (bytes: Uint8Array, box: Box) => ({
	version: bytes[box.body] ?? 0,
	flags: viewOf(bytes).getUint32(box.body) & 0xffffff,
	fields: box.body + 4,
});

function mp4DurationMs(bytes: Uint8Array): number | undefined {
	const whole = mp4WholeEnd(bytes);
	if (whole === undefined) return undefined;
	const view = viewOf(bytes);
	const boxes = boxesIn(bytes, 0, whole);
	const moov = boxes.find((box) => box.type === 'moov')!;
	const trak = childOf(bytes, moov, 'trak');
	const mdhd = childOf(bytes, childOf(bytes, trak, 'mdia'), 'mdhd');
	if (mdhd === undefined) return undefined;
	const { version, fields } = fullBox(bytes, mdhd);
	const timescale = view.getUint32(fields + (version === 1 ? 16 : 8));
	if (timescale === 0) return undefined;
	const trex = childOf(bytes, childOf(bytes, moov, 'mvex'), 'trex');
	const trexDuration =
		trex === undefined ? 0 : view.getUint32(fullBox(bytes, trex).fields + 8);

	const fragments = boxes.filter((box) => box.type === 'moof');
	if (fragments.length === 0) {
		// Not fragmented: the media header names the length.
		const length =
			version === 1
				? Number(view.getBigUint64(fields + 20))
				: view.getUint32(fields + 12);
		return Math.round((length / timescale) * 1000);
	}
	let end = 0;
	for (const moof of fragments)
		for (const traf of boxesIn(bytes, moof.body, moof.end)) {
			if (traf.type !== 'traf') continue;
			let base: number | undefined;
			let defaultDuration = trexDuration;
			let total = 0;
			for (const child of boxesIn(bytes, traf.body, traf.end)) {
				const { version: v, flags, fields: at } = fullBox(bytes, child);
				if (child.type === 'tfdt')
					base = v === 1 ? Number(view.getBigUint64(at)) : view.getUint32(at);
				else if (child.type === 'tfhd' && flags & 0x08) {
					// track_ID, then the optional fields before the default duration.
					let offset = at + 4;
					if (flags & 0x01) offset += 8;
					if (flags & 0x02) offset += 4;
					defaultDuration = view.getUint32(offset);
				} else if (child.type === 'trun') {
					const count = view.getUint32(at);
					let offset = at + 4;
					if (flags & 0x01) offset += 4;
					if (flags & 0x04) offset += 4;
					const perSample =
						(flags & 0x100 ? 4 : 0) +
						(flags & 0x200 ? 4 : 0) +
						(flags & 0x400 ? 4 : 0) +
						(flags & 0x800 ? 4 : 0);
					for (let sample = 0; sample < count; sample++) {
						total += flags & 0x100 ? view.getUint32(offset) : defaultDuration;
						offset += perSample;
					}
				}
			}
			end = Math.max(end, (base ?? end) + total);
		}
	return Math.round((end / timescale) * 1000);
}

// --- WebM -------------------------------------------------------------------

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const CLUSTER = 0x1f43b675;
const TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
/** Elements a segment holds directly: one of them ends a cluster of unknown size. */
const SEGMENT_CHILDREN = new Set([
	0x114d9b74, // SeekHead
	INFO,
	0x1654ae6b, // Tracks
	CLUSTER,
	0x1c53bb6b, // Cues
	0x1941a469, // Attachments
	0x1043a770, // Chapters
	0x1254c367, // Tags
]);

/** A variable-length integer at `offset`: its value, its length, and whether it is "unknown". */
function vint(bytes: Uint8Array, offset: number, keepMarker: boolean) {
	const first = bytes[offset];
	if (first === undefined || first === 0) return undefined;
	const length = Math.clz32(first) - 23;
	if (offset + length > bytes.length) return undefined;
	let value = keepMarker ? first : first & (0xff >> length);
	let unknown = value === 0xff >> length;
	for (let index = 1; index < length; index++) {
		const byte = bytes[offset + index]!;
		value = value * 256 + byte;
		if (byte !== 0xff) unknown = false;
	}
	return { value, length, unknown: !keepMarker && unknown };
}

type Element = {
	readonly id: number;
	readonly start: number;
	/** Where its size field starts and how long it is, to rewrite as unknown. */
	readonly sizeAt: number;
	readonly sizeLength: number;
	readonly body: number;
	/** Its end, or undefined for an unknown size. */
	readonly end: number | undefined;
};

/** The element header at `offset`, or undefined when it is not all there. */
function elementAt(bytes: Uint8Array, offset: number): Element | undefined {
	const id = vint(bytes, offset, true);
	if (id === undefined) return undefined;
	const size = vint(bytes, offset + id.length, false);
	if (size === undefined) return undefined;
	const body = offset + id.length + size.length;
	return {
		id: id.value,
		start: offset,
		sizeAt: offset + id.length,
		sizeLength: size.length,
		body,
		end: size.unknown ? undefined : body + size.value,
	};
}

type WebmWalk = {
	/** Where the file is whole: after the last element read to its end. */
	readonly whole: number;
	/** Known-size containers the cut falls inside, whose sizes then must say "unknown". */
	readonly open: Element[];
	/** Ticks per millisecond's worth of nanoseconds. */
	readonly timecodeScale: number;
	/** The last two blocks' times, in ticks. */
	readonly times: number[];
};

/** Walk a WebM file as far as it is whole, or undefined when it is not WebM. */
function walkWebm(bytes: Uint8Array): WebmWalk | undefined {
	const header = elementAt(bytes, 0);
	if (header?.id !== EBML || header.end === undefined) return undefined;
	const segment = elementAt(bytes, header.end);
	if (segment?.id !== SEGMENT) return undefined;
	let whole = segment.body;
	let timecodeScale = 1_000_000;
	const times: number[] = [];
	const open: Element[] = [];
	let cluster: { element: Element; timecode: number } | undefined;
	const segmentEnd = Math.min(segment.end ?? bytes.length, bytes.length);
	let offset = segment.body;

	while (offset < segmentEnd) {
		const element = elementAt(bytes, offset);
		if (element === undefined) break;
		// Inside a cluster until a segment child, or the cluster's own end.
		if (cluster !== undefined) {
			const clusterEnd = cluster.element.end;
			if (
				SEGMENT_CHILDREN.has(element.id) ||
				(clusterEnd !== undefined && offset >= clusterEnd)
			)
				cluster = undefined;
		}
		if (element.id === CLUSTER) {
			cluster = { element, timecode: 0 };
			whole = element.body;
			offset = element.body;
			continue;
		}
		if (element.end === undefined || element.end > bytes.length) break;
		if (cluster !== undefined) {
			if (element.id === TIMECODE)
				cluster.timecode = uint(bytes, element.body, element.end);
			else if (element.id === SIMPLE_BLOCK || element.id === BLOCK_GROUP) {
				const block =
					element.id === SIMPLE_BLOCK
						? element
						: findChild(bytes, element, BLOCK);
				const time = block && blockTime(bytes, block);
				if (time !== undefined) {
					times.push(cluster.timecode + time);
					if (times.length > 2) times.shift();
				}
			}
		} else if (element.id === INFO) {
			const scale = findChild(bytes, element, TIMECODE_SCALE);
			if (scale !== undefined)
				timecodeScale = uint(bytes, scale.body, scale.end!) || timecodeScale;
		}
		whole = element.end;
		offset = element.end;
	}
	if (segment.end !== undefined && segment.end > whole) open.push(segment);
	const lastCluster = cluster?.element;
	if (lastCluster?.end !== undefined && lastCluster.end > whole)
		open.push(lastCluster);
	return { whole, open, timecodeScale, times };
}

const uint = (bytes: Uint8Array, start: number, end: number) => {
	let value = 0;
	for (let index = start; index < end; index++)
		value = value * 256 + bytes[index]!;
	return value;
};

function findChild(bytes: Uint8Array, parent: Element, id: number) {
	let offset = parent.body;
	while (parent.end !== undefined && offset < parent.end) {
		const child = elementAt(bytes, offset);
		if (child?.end === undefined) return undefined;
		if (child.id === id) return child;
		offset = child.end;
	}
	return undefined;
}

/** A block's time relative to its cluster: after its track number, a signed 16-bit count of ticks. */
function blockTime(bytes: Uint8Array, block: Element) {
	const track = vint(bytes, block.body, false);
	if (track === undefined || block.body + track.length + 2 > block.end!)
		return undefined;
	return viewOf(bytes).getInt16(block.body + track.length);
}

function repairWebm(bytes: Uint8Array): Uint8Array | undefined {
	const walked = walkWebm(bytes);
	if (walked === undefined || walked.whole === bytes.length) return undefined;
	const repaired = bytes.slice(0, walked.whole);
	// A known size that now runs past the end says "unknown" instead: the
	// same length of all ones, so nothing else moves.
	for (const { sizeAt, sizeLength } of walked.open) {
		repaired[sizeAt] = 0xff >> (sizeLength - 1);
		repaired.fill(0xff, sizeAt + 1, sizeAt + sizeLength);
	}
	return repaired;
}

function webmDurationMs(bytes: Uint8Array): number | undefined {
	const walked = walkWebm(bytes);
	if (walked === undefined) return undefined;
	const [before, last] =
		walked.times.length === 2
			? walked.times
			: [walked.times[0], walked.times[0]];
	if (last === undefined || before === undefined) return 0;
	// The last block plays about as long as the gap before it.
	const ticks = last + (last - before);
	return Math.round((ticks * walked.timecodeScale) / 1_000_000);
}
