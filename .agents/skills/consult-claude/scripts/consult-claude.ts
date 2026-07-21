#!/usr/bin/env bun

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const KILL_GRACE_MS = 5 * 1000;
const DEEPWIKI_MCP_CONFIG = JSON.stringify({
	mcpServers: {
		deepwiki: {
			type: 'http',
			url: 'https://mcp.deepwiki.com/mcp',
		},
	},
});

function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals) {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		// The process group has already exited.
	}
}

function processGroupExists(child: ChildProcess) {
	if (!child.pid) return false;
	try {
		process.kill(-child.pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function readPacket() {
	const rawTerminal = process.stdin.isTTY;
	if (rawTerminal) process.stdin.setRawMode(true);

	const chunks: Buffer[] = [];
	try {
		for await (const chunk of process.stdin) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			if (!rawTerminal) {
				chunks.push(buffer);
				continue;
			}

			const eotIndex = buffer.indexOf(0x04);
			if (eotIndex === -1) {
				chunks.push(buffer);
				continue;
			}

			chunks.push(buffer.subarray(0, eotIndex));
			break;
		}
	} finally {
		if (rawTerminal) process.stdin.setRawMode(false);
	}

	return Buffer.concat(chunks).toString('utf8');
}

async function main() {
	if (process.env.CLAUDECODE === '1') {
		console.error('[consult-claude] Refusing to launch nested Claude Code.');
		process.exitCode = 2;
		return;
	}

	const packet = await readPacket();
	if (!packet.trim()) {
		console.error('[consult-claude] Consultation packet is empty.');
		process.exitCode = 2;
		return;
	}
	const taskDirectory = process.cwd();
	const consultationDirectory = mkdtempSync(join(tmpdir(), 'consult-claude-'));

	try {
		const startedAt = Date.now();
		const lifecycle: {
			outcome: 'running' | 'timed_out' | 'canceled';
			killPromise: Promise<void> | undefined;
			cancelKill: (() => void) | undefined;
		} = {
			outcome: 'running',
			killPromise: undefined,
			cancelKill: undefined,
		};

		const child = spawn(
			'claude',
			[
				'-p',
				'--effort',
				'high',
				'--setting-sources',
				'',
				'--disable-slash-commands',
				'--tools',
				'Read,Glob,Grep,Bash,WebFetch,WebSearch',
				'--allowed-tools',
				'WebFetch,WebSearch,mcp__deepwiki__ask_question',
				'--permission-mode',
				'manual',
				'--mcp-config',
				DEEPWIKI_MCP_CONFIG,
				'--strict-mcp-config',
				'--add-dir',
				taskDirectory,
				'--no-session-persistence',
				'--no-chrome',
				'--output-format',
				'text',
			],
			{
				cwd: consultationDirectory,
				detached: true,
				stdio: ['pipe', 'pipe', 'pipe'],
			},
		);
		child.stdout?.pipe(process.stdout);
		child.stderr?.pipe(process.stderr);

		const terminate = (nextOutcome: 'timed_out' | 'canceled') => {
			if (lifecycle.outcome !== 'running') return;
			lifecycle.outcome = nextOutcome;
			terminateProcessGroup(child, 'SIGTERM');
			lifecycle.killPromise = new Promise((resolve) => {
				const killTimer = setTimeout(() => {
					terminateProcessGroup(child, 'SIGKILL');
					resolve();
				}, KILL_GRACE_MS);
				lifecycle.cancelKill = () => {
					clearTimeout(killTimer);
					resolve();
				};
			});
		};

		const onSigint = () => {
			console.error('[consult-claude] Received SIGINT; canceling Claude.');
			terminate('canceled');
		};
		const onSigterm = () => {
			console.error('[consult-claude] Received SIGTERM; canceling Claude.');
			terminate('canceled');
		};
		process.on('SIGINT', onSigint);
		process.on('SIGTERM', onSigterm);

		child.stdin?.on('error', (error) => {
			if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
				console.error(
					`[consult-claude] Could not send packet: ${error.message}`,
				);
			}
		});
		child.stdin?.end(packet);
		console.error('[consult-claude] Claude started.');

		const timeout = setTimeout(() => {
			console.error(
				'[consult-claude] Hard timeout after 30 minutes; terminating Claude.',
			);
			terminate('timed_out');
		}, TIMEOUT_MS);
		timeout.unref();

		const heartbeat = setInterval(() => {
			const elapsedMinutes = Math.floor(
				(Date.now() - startedAt) / HEARTBEAT_MS,
			);
			console.error(
				`[consult-claude] Still running after ${elapsedMinutes} minute(s).`,
			);
		}, HEARTBEAT_MS);
		heartbeat.unref();

		const exitCode = await new Promise<number | null>((resolve) => {
			child.once('error', (error) => {
				console.error(
					`[consult-claude] Could not start Claude: ${error.message}`,
				);
				resolve(1);
			});
			child.once('close', (code) => resolve(code));
		});

		clearTimeout(timeout);
		clearInterval(heartbeat);
		if (!processGroupExists(child)) lifecycle.cancelKill?.();
		if (lifecycle.killPromise) await lifecycle.killPromise;
		process.off('SIGINT', onSigint);
		process.off('SIGTERM', onSigterm);

		if (lifecycle.outcome === 'timed_out') process.exitCode = 124;
		else if (lifecycle.outcome === 'canceled') process.exitCode = 130;
		else process.exitCode = exitCode ?? 1;
	} finally {
		rmSync(consultationDirectory, { force: true, recursive: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
