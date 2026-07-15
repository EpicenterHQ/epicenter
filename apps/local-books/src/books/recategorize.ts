/**
 * `recategorizeExpense`: the one QuickBooks write-back (ADR-0061's single
 * approved verb). It moves an expense transaction's category by sparse-updating
 * the `AccountRef` on its expense lines, then folds QuickBooks' response back
 * into the local mirror.
 *
 * Write-THROUGH, never write-to-mirror: QuickBooks owns the change; the mirror is
 * updated from the authoritative response (with the bumped `SyncToken`), and the
 * next CDC sync reconfirms it. The mirror is never the write target.
 *
 * Concurrency: the current `SyncToken` is read from the mirror and sent with the
 * update. If a bookkeeper changed the object in QuickBooks since the last sync,
 * QuickBooks rejects the stale token (a 409 `Http` error) rather than clobbering
 * their change; the caller should re-sync and retry.
 *
 * Running the `recategorize` verb is the approval. No background loop infers
 * approval from queued work.
 *
 * Read-only is a CORE invariant, not an adapter check: the write is refused here
 * (the single owner) when `readOnly` is set, so the verb-core seam ADR-0072
 * promises is safe to wrap. An MCP or HTTP adapter over this core cannot
 * forget the gate and move money, because `readOnly` is a required argument.
 */

import Type, { type Static } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import { openBooksDb } from '../db.ts';
import { entityDef } from '../entities.ts';
import type { QbClientError } from '../qb-client.ts';
import type { OpenQbClient, QbAccessError } from './qb-access.ts';

/** The line shape that carries an account-based expense category. */
const LINE_DETAIL = 'AccountBasedExpenseLineDetail';

/** The expense transactions a recategorize can target. */
export const RECATEGORIZE_ENTITIES = ['Purchase', 'Bill'] as const;
export type RecategorizeEntity = (typeof RECATEGORIZE_ENTITIES)[number];

/**
 * The mandatory top-level fields QuickBooks demands on an expense update even in
 * sparse mode. A Line-only sparse body is a 400 ValidationFault (code 2020,
 * "Required parameter <field> is missing"), so the update must carry these
 * through unchanged from the mirror's raw object alongside the modified Line.
 *   Purchase: PaymentType (cash/card/check) + AccountRef (the bank/CC account paid from).
 *   Bill:     VendorRef (the vendor owed).
 * Whitelisting by field name (not spreading the whole raw object) keeps read-only
 * and computed fields QuickBooks rejects out of the body. Keying by entity makes
 * it a compile error to add a recategorize entity without declaring its required
 * fields, so a new entity cannot silently ship the broken Line-only body.
 */
const REQUIRED_UPDATE_FIELDS: Record<RecategorizeEntity, readonly string[]> = {
	Purchase: ['PaymentType', 'AccountRef'],
	Bill: ['VendorRef'],
};

export const RecategorizeError = defineErrors({
	ReadOnly: () => ({
		message:
			'Refusing to write: read-only mode is set (LOCAL_BOOKS_READ_ONLY), so recategorize is disabled. query and report stay available.',
	}),
	UnknownEntity: ({ name }: { name: string }) => ({
		message: `recategorize targets a Purchase (card/cash/check expense) or a Bill (vendor bill), not "${name}".`,
	}),
	NotInMirror: ({ entity, id }: { entity: string; id: string }) => ({
		message: `No ${entity} ${id} in the local mirror. Run "local-books sync" first.`,
	}),
	NoExpenseLine: ({
		entity,
		id,
		lineId,
	}: {
		entity: string;
		id: string;
		lineId?: string;
	}) => ({
		message: lineId
			? `${entity} ${id} has no expense line ${lineId} to recategorize.`
			: `${entity} ${id} has no account-based expense line to recategorize.`,
	}),
});
export type RecategorizeError = InferErrors<typeof RecategorizeError>;

/**
 * The validated input to {@link recategorizeExpense}. This TypeBox object is the
 * single source of truth: it IS the MCP `inputSchema` and `Static` derives the
 * in-process type, so the shape is authored once. Field descriptions are the
 * prose the model and `--help` both read.
 */
export const RecategorizeInput = Type.Object({
	entity: Type.Enum(RECATEGORIZE_ENTITIES, {
		description:
			'The expense kind: Purchase (card/cash/check) or Bill (vendor bill).',
	}),
	id: Type.String({
		description: 'The QuickBooks Id of the transaction (the mirror row id).',
	}),
	account_id: Type.String({
		description: 'The target expense account id (an accounts row id).',
	}),
	account_name: Type.Optional(
		Type.String({
			description:
				'The target account display name (optional, readable books).',
		}),
	),
	line_id: Type.Optional(
		Type.String({
			description:
				'Recategorize only this expense line; omit for every expense line.',
		}),
	),
});
export type RecategorizeInput = Static<typeof RecategorizeInput>;

export type RecategorizeChange = {
	lineId: string | null;
	fromAccount: string | null;
	toAccount: string;
};

export type RecategorizeResult = {
	entity: RecategorizeEntity;
	id: string;
	changed: RecategorizeChange[];
	syncToken: string | null;
	/**
	 * Whether the authoritative QuickBooks response was folded into the mirror.
	 * The write itself succeeded either way; `false` means the best-effort fold
	 * failed (lock past busy_timeout, disk error) and the next CDC sync will
	 * reconcile the row. Callers report this honestly instead of always claiming
	 * the fold happened.
	 */
	folded: boolean;
};

type ExpenseLine = Record<string, unknown> & {
	Id?: string | number;
	[LINE_DETAIL]?: { AccountRef?: { value?: string; name?: string } };
};

/** Validate a raw entity name against the closed set, the verb's parse step. */
export function parseRecategorizeEntity(
	name: string,
): Result<RecategorizeEntity, RecategorizeError> {
	if ((RECATEGORIZE_ENTITIES as readonly string[]).includes(name)) {
		return Ok(name as RecategorizeEntity);
	}
	return RecategorizeError.UnknownEntity({ name });
}

export async function recategorizeExpense({
	openQb,
	dbPath,
	input,
	readOnly,
}: {
	openQb: OpenQbClient;
	dbPath: string;
	input: RecategorizeInput;
	/**
	 * Whether writes are forbidden. Required (no default) so every caller, the
	 * CLI, HTTP, and MCP adapters must decide explicitly; a
	 * wrapper cannot silently skip the gate. This core is the single owner of the
	 * read-only invariant.
	 */
	readOnly: boolean;
}): Promise<
	Result<RecategorizeResult, RecategorizeError | QbAccessError | QbClientError>
> {
	if (readOnly) return RecategorizeError.ReadOnly();
	const def = entityDef(input.entity);
	const db = openBooksDb(dbPath);
	try {
		const raw = db.getLiveRaw(def, input.id);
		if (raw === null) {
			return RecategorizeError.NotInMirror({
				entity: input.entity,
				id: input.id,
			});
		}

		const obj = JSON.parse(raw) as Record<string, unknown>;
		const lines: ExpenseLine[] = Array.isArray(obj.Line)
			? (obj.Line as ExpenseLine[])
			: [];
		const targets = lines.filter(
			(line) =>
				line[LINE_DETAIL] != null &&
				(input.line_id == null || String(line.Id) === input.line_id),
		);
		if (targets.length === 0) {
			return RecategorizeError.NoExpenseLine({
				entity: input.entity,
				id: input.id,
				lineId: input.line_id,
			});
		}

		const toName = input.account_name ?? input.account_id;
		const changed: RecategorizeChange[] = targets.map((line) => {
			const fromRef = line[LINE_DETAIL]?.AccountRef;
			return {
				lineId: line.Id != null ? String(line.Id) : null,
				fromAccount: fromRef?.name ?? fromRef?.value ?? null,
				toAccount: toName,
			};
		});

		// Rewrite each target line's AccountRef in place. This is network-visible:
		// `lines` is sent to QuickBooks below. Kept as an explicit loop, separate from
		// the pure `changed` map above, so the mutation is not a side effect buried in
		// an expression whose name promises only an audit log.
		for (const line of targets) {
			line[LINE_DETAIL] = {
				...line[LINE_DETAIL],
				AccountRef: {
					value: input.account_id,
					...(input.account_name ? { name: input.account_name } : {}),
				},
			};
		}

		const { data: qb, error: openError } = await openQb();
		if (openError !== null) return Err(openError);

		// Sparse update: send the modified Line array with Id + the SyncToken read
		// from the mirror, plus this entity's mandatory top-level fields carried
		// through by value. QuickBooks does NOT infer them on a sparse update; a
		// Line-only body is a 400 ValidationFault (code 2020). It preserves the
		// unnamed writable fields; the named ones must be present, changed or not.
		const required = Object.fromEntries(
			REQUIRED_UPDATE_FIELDS[input.entity].map((field) => [field, obj[field]]),
		);
		const { data: updated, error } = await qb.update(input.entity, {
			...required,
			Id: obj.Id,
			SyncToken: obj.SyncToken,
			sparse: true,
			Line: lines,
		});
		// Re-wrap as a Result: a bare error variant would be Ok-wrapped and read as
		// success. A stale SyncToken (409) lands here.
		if (error) return Err(error);

		// QuickBooks has committed the change, so the operation has succeeded. Fold
		// the authoritative response into the mirror through the shared monotonic
		// ingest so a read sees it immediately. Best-effort: if it cannot write (a
		// concurrent sync holding the lock past busy_timeout, a disk error), the next
		// monotonic CDC sync reconciles the row, and the successful QuickBooks write
		// must not be reported as a failure (which would invite a retry that hits a
		// 409 on the now-bumped token).
		const { error: foldError } = trySync({
			try: () =>
				db.ingest([{ def, objects: [updated] }], {
					syncedAt: new Date().toISOString(),
				}),
			catch: (cause) => Err(cause),
		});

		return Ok({
			entity: input.entity,
			id: String(updated.Id),
			changed,
			syncToken:
				typeof updated.SyncToken === 'string' ? updated.SyncToken : null,
			folded: foldError === null,
		});
	} finally {
		db.close();
	}
}
