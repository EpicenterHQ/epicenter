/**
 * Agent Tool Approval Tests
 *
 * Verifies that every call passes through catalog membership and approval.
 *
 * Key behaviors:
 * - Queries auto-run while mutations ask by default
 * - Denial and abort prevent resolution
 * - Approved listed calls resolve
 */
import { describe, expect, test } from 'bun:test';
import {
	type Approval,
	defaultApprovalDecision,
	resolveApprovedToolCall,
	type ToolCatalog,
} from './tools.js';

const call = { toolCallId: '1', toolName: 'write', input: {} };

function setup() {
	const resolved: string[] = [];
	const tools: ToolCatalog = {
		definitions: () => [{ name: 'write', kind: 'mutation' }],
		resolve: async (value) => {
			resolved.push(value.toolName);
			return { content: 'ran', isError: false };
		},
	};
	return { resolved, tools };
}

describe('tool approval', () => {
	test('default policy auto-runs queries and asks for mutations', () => {
		expect(defaultApprovalDecision(call, { name: 'read', kind: 'query' })).toBe(
			'auto',
		);
		expect(
			defaultApprovalDecision(call, { name: 'write', kind: 'mutation' }),
		).toBe('ask');
	});

	test('policy denial prevents resolution', async () => {
		const { resolved, tools } = setup();
		const approval: Approval = {
			decide: () => 'deny',
			request: async () => true,
		};
		expect(
			await resolveApprovedToolCall({
				tools,
				approval,
				call,
				signal: new AbortController().signal,
			}),
		).toEqual({ content: 'Denied by policy.', isError: true });
		expect(resolved).toEqual([]);
	});

	test('a stop during approval wins over late approval', async () => {
		const { resolved, tools } = setup();
		const controller = new AbortController();
		const approval: Approval = {
			decide: () => 'ask',
			request: async () => {
				controller.abort();
				return true;
			},
		};
		const outcome = await resolveApprovedToolCall({
			tools,
			approval,
			call,
			signal: controller.signal,
		});
		expect(outcome.isError).toBe(true);
		expect(resolved).toEqual([]);
	});

	test('a declined approval prevents resolution', async () => {
		const { resolved, tools } = setup();
		const outcome = await resolveApprovedToolCall({
			tools,
			approval: { decide: () => 'ask', request: async () => false },
			call,
			signal: new AbortController().signal,
		});
		expect(outcome).toEqual({
			content: 'Denied by the user.',
			isError: true,
		});
		expect(resolved).toEqual([]);
	});

	test('listed approved calls resolve and unlisted calls fail closed', async () => {
		const { resolved, tools } = setup();
		const approval: Approval = {
			decide: () => 'auto',
			request: async () => true,
		};
		expect(
			await resolveApprovedToolCall({
				tools,
				approval,
				call,
				signal: new AbortController().signal,
			}),
		).toEqual({ content: 'ran', isError: false });
		const missing = await resolveApprovedToolCall({
			tools,
			approval,
			call: { ...call, toolName: 'missing' },
			signal: new AbortController().signal,
		});
		expect(missing.isError).toBe(true);
		expect(resolved).toEqual(['write']);
	});
});
