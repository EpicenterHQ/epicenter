/**
 * The two durable pools every surface reads: saved phrases and past sessions.
 *
 * Both are shared. Chat, Conversation, Practice, and Revisit read the same
 * `SavedPhrase[]` and the same `PastSession[]`; none of them owns a private
 * store, a per-surface queue, or a per-surface flag. That is the whole point of
 * the prototype: a surface is an *opening*, not a data model.
 *
 * `SavedPhrase` is ADR-0102's entry shape held verbatim, including its
 * refusals: no stored gloss, no `dueAt`, no review interval, no exposure or
 * production counter, no provenance column, no `language`, no `updatedAt`.
 * `stage` is the one acquisition dial and it is human-set only.
 */

/** A span of Chinese saved by selecting it, of any length (word, phrase, chengyu). */
export type SavedPhrase = {
	id: string;
	/** The verbatim selection, trimmed, never normalized. */
	text: string;
	/** Human-owned free text. No code path in this prototype writes it. */
	note: string;
	/**
	 * The single acquisition dial. `new`: saved because you did not know it.
	 * `understood`: you comprehend it on reading or hearing. `usable`: you can
	 * produce it. Set by the human on the phrase list, never by a scheduler and
	 * never by the tutor.
	 */
	stage: 'new' | 'understood' | 'usable';
	/** Sort key only; row ids are not time-ordered. */
	createdAt: number;
};

/** One durable turn of a past session. `tutor` is the assistant role. */
export type Turn = {
	role: 'user' | 'tutor';
	/** Clean text exactly as it was persisted: no pinyin, no highlight markup. */
	text: string;
};

/**
 * A finished session, kept as durable conversation history.
 *
 * There is deliberately no "today's room". A session is identified by its own
 * id and remembered by what was said in it, so returning to a topic means
 * finding the sessions that discussed it, not reopening a dated room. Practice
 * and Revisit therefore never take a date, and nothing here expires.
 */
export type PastSession = {
	id: string;
	/** Which opening started it. Recorded for display; never read as a filter. */
	intent: SessionIntentName;
	startedAt: number;
	turns: Turn[];
};

/** The four entry surfaces. `chat` is the default; the other three are openings. */
export type SessionIntentName = 'chat' | 'conversation' | 'practice' | 'revisit';
