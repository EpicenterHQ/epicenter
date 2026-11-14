import {join} from 'node:path';
import {mkdirSync,mkdtempSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
const out='/Users/braden/Code/epicenter/.agents/skills/skills-and-instructions/evals/runs/2026-10-22-greenfield-models';
const m=await Bun.file(join(out,'private-manifest.json')).json();
const launcher='/Users/braden/Code/epicenter/.agents/skills/consult-claude/scripts/consult-claude.ts';
const progress=await Bun.file(join(out,'execution-progress.json')).json();
if(progress.length!==16||progress.some((x:any)=>x.exitCode||x.isError||x.parseError))throw new Error('Generation is not complete and valid');
const jobs:any[]=[];
for(const skill of ['rethink','adversarial-review'])for(const task of ['file-editing','photo-import']){
 const cwd=mkdtempSync(join(tmpdir(),'blind-comparison-'));const init=Bun.spawn(['git','init','-q',cwd]);if(await init.exited)throw new Error('git init');
 const matching=m.jobs.filter((j:any)=>j.skill===skill&&j.task===task);
 let packet=`# Task\n\n${await Bun.file(join(matching[0].cwd,'REQUEST.md')).text()}\n\n# Responses\n\n`;
 for(let repeat=1;repeat<=2;repeat++)for(const label of ['A','B']){const j=matching.find((j:any)=>j.repeat===repeat&&j.label===label);const answer=await Bun.file(join(out,j.prefix+'.answer.md')).text();packet+=`## Pair ${repeat}, response ${label}\n\n${answer}\n\n`;}
 await Bun.write(join(cwd,'COMPARISON.md'),packet);
 if(task==='file-editing')for(const dir of ['packages','apps'])cpSync(join(matching[0].cwd,dir),join(cwd,dir),{recursive:true});
 if(task==='file-editing'){
  const compiler=await Bun.file(join(out,'svelte-syntax-checks.json')).json();
  await Bun.write(join(cwd,'COMPILER-CHECKS.json'),JSON.stringify({...compiler,checks:compiler.checks.filter((x:any)=>x.skill===skill)},null,2));
 }
 const prompt=`Compare the two independent response pairs in COMPARISON.md. You are a blind design-quality judge. No version identities or preferred solution are supplied. Each pair independently randomizes A/B. Judge each pair separately, then assess consistency across repetitions. Do not guess which is newer or reward novelty, length, confidence, more alternatives, or fewer types. Do not edit files, run commands, or launch agents. Read deciding source evidence where it would change your judgment. For file editing, COMPILER-CHECKS.json contains mechanical Svelte syntax results with author-labeled multiple components separated. These do not resolve imports, types, or API semantics; weigh them as concrete-use evidence without letting syntax alone decide architecture quality.

Judge independent formation of a coherent model; realistic operations and lifecycle consequences; respect for explicit requirements or clearly labeled proposals to change them; information preservation and hidden or displaced complexity; and a useful recommendation supported by available evidence. This is an initial conceptual answer, not implemented code. It need not find a particular architecture. For file editing examine typing during save, revert/retry/conflict/deletion, bounded save/flush, and vanilla/Svelte coherence. For photo import examine byte identity versus provenance, original preservation independent of previews, durable progress versus source permission, overlapping reselection, cancellation/retry, and precise completion meaning.

Return at most 1400 words. For each pair state A, B, or tie, confidence low/medium/high, the decisive substantive differences, exact short quotations supporting your findings, and material correctness/requirement concerns in either response. Distinguish demonstrated inconsistencies from uncertain implementation details. Then say whether either pair offers convincing improvement and what remains untested. Avoid numeric scores that imply precision. An inability to distinguish quality is a valid result.\n`;
 const prefix=`judge-${skill}-${task}`;await Bun.write(join(out,prefix+'.prompt.txt'),prompt);await Bun.write(join(out,prefix+'.packet.md'),packet);jobs.push({cwd,prompt,prefix});
}
const queue=[...jobs];const records:any[]=[];
await Promise.all(Array.from({length:2},async()=>{while(queue.length){const j=queue.shift()!;console.log(JSON.stringify({event:'judge-started',prefix:j.prefix}));const child=Bun.spawn(['/Users/braden/.bun/bin/bun',launcher,'--account','personal','--account-email','claude@bradenwong.com','--model',m.model,'--effort',m.effort],{cwd:j.cwd,stdin:new Blob([j.prompt]),stdout:Bun.file(join(out,j.prefix+'.native.json')),stderr:Bun.file(join(out,j.prefix+'.stderr.txt'))});const exitCode=await child.exited;const raw=await Bun.file(join(out,j.prefix+'.native.json')).json();if(typeof raw.result==='string')await Bun.write(join(out,j.prefix+'.assessment.md'),raw.result+'\n');const record={prefix:j.prefix,cwd:j.cwd,exitCode,sessionId:raw.session_id,isError:raw.is_error,permissionDenials:raw.permission_denials??[],models:Object.keys(raw.modelUsage??{}),costUsd:raw.total_cost_usd};records.push(record);await Bun.write(join(out,'judge-progress.json'),JSON.stringify(records,null,2));console.log(JSON.stringify({event:'judge-finished',...record}));}}));
