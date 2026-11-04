/**
 * Agent Tool Tests
 *
 * The tools are an array, and a tool left out is denied.
 *
 * Key behaviors:
 * - A call naming a tool not offered runs nothing
 * - A tool that reads runs without asking; one that mutates asks first
 * - With no one to ask, a mutating tool is refused
 * - A declined approval, or a stop while asking, runs nothing
 */
import { describe, expect, test } from 'bun:test';
import { type AgentTool, runTool, toChatTools } from './tools.js';

function setup() {
	const ran: string[] = [];
	const tool = (name: string, mutates?: boolean): AgentTool => ({
		name,
		description: `${name} something`,
		mutates,
		async run(input) {
			ran.push(`${name} ${JSON.stringify(input)}`);
			return { content: 'ran', isError: false };
		},
	});
	return { ran, tools: [tool('read'), tool('write', true)] };
}

const call = (toolName: string) => ({
	toolCallId: '1',
	toolName,
	input: { at: 1 },
});
const live = () => new AbortController().signal;

describe('runTool', () => {
	test('a call naming a tool not offered runs nothing', async () => {
		const { ran, tools } = setup();
		const outcome = await runTool({
			tools,
			approve: async () => true,
			call: call('delete'),
			signal: live(),
		});
		expect(outcome).toEqual({
			content: 'No tool named delete is available.',
			isError: true,
		});
		expect(ran).toEqual([]);
	});

	test('a tool that reads runs without asking; one that mutates asks first', async () => {
		const { ran, tools } = setup();
		const asked: string[] = [];
		const approve = async (_call: unknown, tool: AgentTool) => {
			asked.push(tool.name);
			return true;
		};
		await runTool({ tools, approve, call: call('read'), signal: live() });
		await runTool({ tools, approve, call: call('write'), signal: live() });
		expect(asked).toEqual(['write']);
		expect(ran).toEqual(['read {"at":1}', 'write {"at":1}']);
	});

	test('with no one to ask, a mutating tool is refused', async () => {
		const { ran, tools } = setup();
		const outcome = await runTool({
			tools,
			approve: undefined,
			call: call('write'),
			signal: live(),
		});
		expect(outcome.isError).toBe(true);
		expect(ran).toEqual([]);
	});

	test('a declined approval, or a stop while asking, runs nothing', async () => {
		const { ran, tools } = setup();
		expect(
			await runTool({
				tools,
				approve: async () => false,
				call: call('write'),
				signal: live(),
			}),
		).toEqual({ content: 'Denied by the user.', isError: true });

		const stopping = new AbortController();
		expect(
			await runTool({
				tools,
				approve: async () => {
					stopping.abort();
					return true;
				},
				call: call('write'),
				signal: stopping.signal,
			}),
		).toEqual({ content: 'Stopped before the tool ran.', isError: true });
		expect(ran).toEqual([]);
	});
});

test('tools are offered as OpenAI functions, a missing schema as the empty object', () => {
	expect(toChatTools(setup().tools.slice(0, 1))).toEqual([
		{
			type: 'function',
			function: {
				name: 'read',
				description: 'read something',
				parameters: { type: 'object', properties: {} },
			},
		},
	]);
});
