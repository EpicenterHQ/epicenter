/** Native stdio ownership tests cover fragmented RPC frames, inherited connector disabling, sign-in readiness, and close drain. */
import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAi } from './codex-ai.js';
import { openCodexConnection } from './codex-connection.js';

async function fixture(mode = 'normal') {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-codex-fixture-'));
	const executable = join(directory, 'codex');
	await Bun.write(
		executable,
		`#!${process.execPath}
const mode=${JSON.stringify(mode)};
if(process.argv.includes('--version')){console.log('codex-cli '+(mode==='old'?'0.154.0':'0.160.1'));process.exit(0);}
let lastThread;
const send = message => { const line=JSON.stringify(message)+'\\n'; process.stdout.write(line.slice(0,5));process.stdout.write(line.slice(5)); };
let buffer='';
for await(const chunk of Bun.stdin.stream()){
 buffer+=new TextDecoder().decode(chunk);let end;
 while((end=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;const message=JSON.parse(line);if(message.id===undefined)continue;
 let result={};
 if(message.method==='turn/interrupt'&&mode==='cleanup-failure'){send({id:message.id,error:{code:-32000,message:'Cannot interrupt'}});continue;}
 if(message.method==='config/read')result={config:{mcp_servers:{inherited:{command:'never-run',enabled:true}}}};
 if(message.method==='account/read')result={requiresOpenaiAuth:true,account:mode==='signed-out'?null:{type:'chatgpt'}};
 if(message.method==='thread/start'){lastThread=message.params;result={thread:{id:'thread',ephemeral:true}};}
 if(message.method==='turn/start')result={turn:{id:'turn'}};
 if(message.method==='probe')result=lastThread??{};
 send({id:message.id,result});
 if(message.method==='turn/start')send({method:'turn/started',params:{threadId:'thread',turn:{id:'turn'}}});
 if(message.method==='probe'&&mode==='server-request')send({id:'server',method:'item/tool/call',params:{}});
 }
}
`,
	);
	await chmod(executable, 0o700);
	return {
		executable,
		dispose: () => rm(directory, { recursive: true, force: true }),
	};
}

test('dedicated connection forces isolated thread configuration and drains a waiting attempt on close', async () => {
	const fake = await fixture();
	try {
		const connection = await openCodexConnection({
			executable: fake.executable,
		});
		const started = await connection.request('thread/start', {
			ephemeral: false,
			cwd: '/untrusted',
			config: { 'features.shell_tool': true },
			environments: [{ id: 'unsafe' }],
		});
		expect(started).toEqual({ thread: { id: 'thread', ephemeral: true } });
		const actual = await connection.request('probe', {});
		expect(actual).toMatchObject({
			ephemeral: true,
			environments: [],
			dynamicTools: [],
			config: {
				'features.shell_tool': false,
				mcp_servers: { inherited: { enabled: false } },
			},
		});
		const iterator = createCodexAi(connection, { model: 'chosen' }).reply({
			instructions: 'Tutor',
			messages: [],
			signal: new AbortController().signal,
		});
		const pending = iterator.next();
		// Wait for thread admission without a wall-clock delay.
		await connection.request('probe', {});
		const closed = connection.close();
		expect(connection.close()).toBe(closed);
		expect((await pending).value).toMatchObject({
			type: 'result',
			result: { error: { name: 'Closed' } },
		});
		await closed;
		await expect(connection.request('probe', {})).rejects.toThrow();
	} finally {
		await fake.dispose();
	}
});

for (const mode of ['old', 'signed-out'])
	test(`opening rejects ${mode} Codex before exposing a handle`, async () => {
		const fake = await fixture(mode);
		try {
			await expect(
				openCodexConnection({ executable: fake.executable }),
			).rejects.toThrow();
		} finally {
			await fake.dispose();
		}
	});

test('unsolicited server requests retire the text-only connection', async () => {
	const fake = await fixture('server-request');
	try {
		const connection = await openCodexConnection({
			executable: fake.executable,
		});
		const retired = new Promise<void>((resolve) =>
			connection.signal.addEventListener('abort', () => resolve(), {
				once: true,
			}),
		);
		await connection.request('probe', {});
		await retired;
		expect(connection.signal.aborted).toBe(true);
		await connection.close();
	} finally {
		await fake.dispose();
	}
});

test('failed turn interruption retires the process and drains admitted cleanup', async () => {
	const fake = await fixture('cleanup-failure');
	try {
		const connection = await openCodexConnection({
			executable: fake.executable,
		});
		await expect(
			connection.request('turn/interrupt', {
				threadId: 'thread',
				turnId: 'turn',
			}),
		).rejects.toThrow();
		expect(connection.signal.aborted).toBe(true);
		await connection.close();
		await expect(connection.request('thread/start', {})).rejects.toThrow();
	} finally {
		await fake.dispose();
	}
});
