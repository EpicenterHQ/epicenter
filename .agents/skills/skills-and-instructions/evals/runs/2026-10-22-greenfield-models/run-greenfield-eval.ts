import { join } from 'node:path';
const out='/Users/braden/Code/epicenter/.agents/skills/skills-and-instructions/evals/runs/2026-10-22-greenfield-models';
const manifest=await Bun.file(join(out,'private-manifest.json')).json();
const launcher='/Users/braden/Code/epicenter/.agents/skills/consult-claude/scripts/consult-claude.ts';
const queue=[...manifest.jobs].sort(()=>Math.random()-.5);
const progress:any[]=[];
async function run(job:any){
 const startedAt=new Date().toISOString();console.log(JSON.stringify({event:'started',id:job.id,skill:job.skill,task:job.task,repeat:job.repeat,label:job.label}));
 const child=Bun.spawn(['/Users/braden/.bun/bin/bun',launcher,'--account','personal','--account-email','claude@bradenwong.com','--model',manifest.model,'--effort',manifest.effort],{cwd:job.cwd,stdin:new Blob([job.prompt]),stdout:Bun.file(join(out,job.prefix+'.native.json')),stderr:Bun.file(join(out,job.prefix+'.stderr.txt'))});
 const exitCode=await child.exited;
 let raw:any={};let parseError;
 try{raw=await Bun.file(join(out,job.prefix+'.native.json')).json();}catch(error){parseError=String(error);}
 const record={id:job.id,prefix:job.prefix,skill:job.skill,task:job.task,repeat:job.repeat,label:job.label,startedAt,finishedAt:new Date().toISOString(),exitCode,sessionId:raw.session_id,isError:raw.is_error,stopReason:raw.stop_reason,permissionDenials:raw.permission_denials??[],models:Object.keys(raw.modelUsage??{}),costUsd:raw.total_cost_usd,words:typeof raw.result==='string'?raw.result.trim().split(/\s+/).length:0,parseError};
 if(typeof raw.result==='string')await Bun.write(join(out,job.prefix+'.answer.md'),raw.result+'\n');
 progress.push(record);await Bun.write(join(out,'execution-progress.json'),JSON.stringify(progress,null,2));console.log(JSON.stringify({event:'finished',...record}));
}
await Promise.all(Array.from({length:3},async()=>{while(queue.length){const job=queue.shift();await run(job);}}));
console.log(JSON.stringify({event:'complete',runs:progress.length,valid:progress.filter(x=>x.exitCode===0&&!x.isError&&!x.parseError).length,costUsd:progress.reduce((n,x)=>n+(x.costUsd??0),0)}));
