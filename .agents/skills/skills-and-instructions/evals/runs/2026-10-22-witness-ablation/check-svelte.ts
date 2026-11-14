import {join} from 'node:path';
const out='/Users/braden/Code/epicenter/.agents/skills/skills-and-instructions/evals/runs/2026-10-22-witness-ablation';
const m=await Bun.file(join(out,'private-manifest.json')).json();
const compilerPath=Bun.resolveSync('svelte/compiler','/Users/braden/Code/worktrees/epicenter-stable/packages/svelte');
const {compile,VERSION}=await import(compilerPath);
const checks:any[]=[];
for(const job of m.jobs.filter((x:any)=>x.task==='file-editing')){
 const file=Bun.file(join(out,job.prefix+'.answer.md'));if(!await file.exists())continue;
 const text=await file.text();const snippets=[...text.matchAll(/```svelte\s*\n([\s\S]*?)```/g)];
 const records=[];
 const components=snippets.flatMap((match,block)=>{
  const markers=[...match[1].matchAll(/<!--\s*([\w./-]+\.svelte)\s*-->/g)];
  if(markers.length<2)return [{source:match[1],block:block+1,component:markers[0]?.[1]}];
  return markers.map((marker,index)=>({source:match[1].slice(marker.index!+marker[0].length,markers[index+1]?.index??match[1].length),block:block+1,component:marker[1]}));
 });
 for(const [index,component]of components.entries()){
  try{const compiled=compile(component.source,{filename:component.component??`sample-${index+1}.svelte`,generate:'client'});records.push({index:index+1,block:component.block,component:component.component,validSyntax:true,warnings:compiled.warnings.map((x:any)=>({code:x.code,message:x.message}))});}
  catch(error:any){records.push({index:index+1,block:component.block,component:component.component,validSyntax:false,code:error.code,message:error.message,frame:error.frame});}
 }
 checks.push({prefix:job.prefix,skill:job.skill,repeat:job.repeat,label:job.label,snippets:records});
}
await Bun.write(join(out,'svelte-syntax-checks.json'),JSON.stringify({compiler:compilerPath,version:VERSION,scope:'Components separated at explicit author filename markers. Standalone compiler only; does not resolve imported types, validate APIs, or prove runtime behavior',checks},null,2));
console.log(JSON.stringify({answers:checks.length,snippets:checks.reduce((n,x)=>n+x.snippets.length,0),failedSnippets:checks.flatMap(x=>x.snippets).filter(x=>!x.validSyntax).length}));
