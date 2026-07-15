/**
 * `fetchReport`: a live computed financial statement from the QuickBooks Reports
 * API. Where `queryBooks` answers row-level questions off the local mirror, this
 * answers whole-ledger questions QuickBooks owns the *computation* of (P&L,
 * balance sheet, cash flow, aging, trial balance).
 *
 * Reports are read live, never mirrored and never cached: there is no CDC for a
 * report, so a cached copy would be a stale snapshot. The mirror holds the facts;
 * QuickBooks computes the opinions (ADR-0061). A report is one cheap call asked a
 * few times a day, so live is both correct and affordable.
 *
 * The `report` CLI verb and app-owned adapters call this same function.
 */

import Type, { type Static } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { QbClientError } from '../qb-client.ts';
import type { OpenQbClient, QbAccessError } from './qb-access.ts';

/** The reports QuickBooks computes that this verb runs live. */
export const REPORT_NAMES = [
	'ProfitAndLoss',
	'BalanceSheet',
	'CashFlow',
	'AgedReceivables',
	'AgedPayables',
	'TrialBalance',
] as const;
export type ReportName = (typeof REPORT_NAMES)[number];

export const ReportError = defineErrors({
	UnknownReport: ({ name }: { name: string }) => ({
		message: `Unknown report "${name}". Choose one of: ${REPORT_NAMES.join(', ')}.`,
	}),
});
export type ReportError = InferErrors<typeof ReportError>;

/**
 * The validated input to {@link fetchReport}. This TypeBox object is the single
 * source of truth: it IS the MCP `inputSchema` (TypeBox is JSON Schema at
 * runtime) and `Static` derives the in-process type, so the shape is authored
 * once. Field descriptions are the prose the model and `--help` both read.
 */
export const ReportInput = Type.Object({
	report: Type.Enum(REPORT_NAMES, {
		description: 'The statement to compute.',
	}),
	start_date: Type.Optional(
		Type.String({ description: 'Report period start, YYYY-MM-DD.' }),
	),
	end_date: Type.Optional(
		Type.String({ description: 'Report period end, YYYY-MM-DD.' }),
	),
	accounting_method: Type.Optional(
		Type.Enum(['Cash', 'Accrual'] as const, {
			description: 'Cash or Accrual basis; defaults to the company setting.',
		}),
	),
});
export type ReportInput = Static<typeof ReportInput>;

/** Validate a raw report name against the closed set, the verb's parse step. */
export function parseReportName(name: string): Result<ReportName, ReportError> {
	if ((REPORT_NAMES as readonly string[]).includes(name)) {
		return Ok(name as ReportName);
	}
	return ReportError.UnknownReport({ name });
}

export async function fetchReport({
	openQb,
	input,
}: {
	openQb: OpenQbClient;
	input: ReportInput;
}): Promise<
	Result<
		{ report: ReportName; data: Record<string, unknown> },
		ReportError | QbAccessError | QbClientError
	>
> {
	const { data: qb, error: openError } = await openQb();
	if (openError !== null) return Err(openError);

	const params: Record<string, string> = {};
	if (input.start_date) params.start_date = input.start_date;
	if (input.end_date) params.end_date = input.end_date;
	if (input.accounting_method)
		params.accounting_method = input.accounting_method;

	const { data, error } = await qb.report(input.report, params);
	if (error) return Err(error);
	return Ok({ report: input.report, data });
}
