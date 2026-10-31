/**
 * Phrase capture, as plain functions over the DOM of a conversation.
 *
 * A phrase is an exact run of text from one line of one saved tutor answer.
 * Nothing here judges what language or script the text is in: the characters
 * the message has are the characters the phrase gets.
 */

/** The Markdown elements that start a new line of text. */
const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,td,th,pre,blockquote';
const SHOW_ELEMENT_AND_TEXT = 0x1 | 0x4;
const ELEMENT = 1;
const TEXT = 3;

/**
 * Marks the element holding one phrase source: a completed tutor message that
 * Vocab has saved. Its value is the message's ID. The conversation view
 * is the only writer of this attribute, so an unsaved or arriving message
 * never carries it.
 */
const SOURCE = '[data-phrase-source]';
/** Marks page furniture beside a message, such as its button. */
const BESIDE = '[data-capture-skip]';

/**
 * A message's text as it reads on screen, one line per block or `<br>`. A
 * phrase typed by hand is checked against this.
 */
export function messageText(message: Element): string {
	const lines: string[] = [];
	let line = '';
	let block: Element | undefined;
	const end = () => {
		if (line !== '') lines.push(line);
		line = '';
	};
	const walker = message.ownerDocument.createTreeWalker(
		message,
		SHOW_ELEMENT_AND_TEXT,
	);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.nodeType === ELEMENT) {
			if ((node as Element).localName === 'br') end();
			continue;
		}
		const owner = node.parentElement?.closest(BLOCKS) ?? message;
		if (owner !== block) end();
		block = owner;
		line += (node as Text).data;
	}
	end();
	return lines.join('\n');
}

/** Whether `phrase` is one exact run of text within one line of the message. */
export function messageHasPhrase(message: Element, phrase: string): boolean {
	return (
		phrase !== '' &&
		!/[\r\n]/.test(phrase) &&
		messageText(message).includes(phrase)
	);
}

/**
 * Whether `message` is a phrase source right now and still holds `phrase`.
 * Asked again when a phrase is accepted: the element a candidate was read
 * from may since have left the page or stopped being a source.
 */
export function sourceHoldsPhrase(message: Element, phrase: string): boolean {
	return (
		message.isConnected &&
		message.matches(SOURCE) &&
		messageHasPhrase(message, phrase)
	);
}

export type CapturedPhrase = {
	/** The selected text, trimmed and otherwise exactly as the message has it. */
	text: string;
	messageId: string;
	message: HTMLElement;
	/** Exactly the selected text within the message, for placing the popover. */
	range: Range;
};

/**
 * Read a selection as one phrase from one phrase source, or as nothing.
 *
 * The text is gathered from the selected text nodes themselves, so it is the
 * message's own characters and its lines are known. A selection is refused
 * when it takes in text from another message, from a reply that is still
 * arriving or a message that is not saved, or from more than one line.
 * Buttons beside a message are ignored, as is whitespace, because a native
 * selection often runs a little past its message.
 */
export function capturePhrase(
	selection: Selection | null,
): CapturedPhrase | undefined {
	if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return;
	const range = selection.getRangeAt(0);
	const common = range.commonAncestorContainer;
	const document = common.ownerDocument;
	if (!document) return;

	// Assigned inside `take`, so they are declared with their full types.
	type Point = { node: Text; offset: number };
	let message = undefined as HTMLElement | undefined;
	let block = undefined as Element | undefined;
	let first = undefined as Point | undefined;
	let last = undefined as Point | undefined;
	let broken = false;
	let text = '';

	const take = (node: Text): boolean => {
		const from = node === range.startContainer ? range.startOffset : 0;
		const to = node === range.endContainer ? range.endOffset : node.data.length;
		const slice = node.data.slice(from, to);
		const parent = node.parentElement;
		if (slice === '' || !parent || parent.closest(BESIDE)) return true;
		const owner = parent.closest<HTMLElement>(SOURCE);
		if (!owner) return slice.trim() === '';
		if (message && owner !== message) return false;
		message = owner;
		const line = parent.closest(BLOCKS) ?? owner;
		if (first && (broken || line !== block)) text += '\n';
		broken = false;
		block = line;
		text += slice;
		first ??= { node, offset: from };
		last = { node, offset: to };
		return true;
	};

	if (common.nodeType === TEXT) {
		if (!take(common as Text)) return;
	} else {
		const walker = document.createTreeWalker(common, SHOW_ELEMENT_AND_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!range.intersectsNode(node)) continue;
			if (node.nodeType === ELEMENT) {
				if ((node as Element).localName === 'br' && first) broken = true;
			} else if (!take(node as Text)) return;
		}
	}

	const phrase = text.trim();
	if (!message || !first || !last || !message.isConnected) return;
	if (phrase === '' || /[\r\n]/.test(phrase)) return;
	const messageId = message.dataset.phraseSource;
	if (!messageId) return;
	const tight = document.createRange();
	tight.setStart(first.node, first.offset);
	tight.setEnd(last.node, last.offset);
	return { text: phrase, messageId, message, range: tight };
}
