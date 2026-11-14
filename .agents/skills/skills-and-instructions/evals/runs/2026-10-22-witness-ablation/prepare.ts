import {join} from 'node:path';
import {mkdirSync,mkdtempSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
const parent='/Users/braden/Code/epicenter/.agents/skills/skills-and-instructions/evals/runs/2026-10-22-greenfield-models';
const out='/Users/braden/Code/epicenter/.agents/skills/skills-and-instructions/evals/runs/2026-10-22-witness-ablation';
const old=await Bun.file(join(parent,'private-manifest.json')).json();
const files=await Bun.file(join(parent,'input-fingerprints.json')).json();
const root=mkdtempSync(join(tmpdir(),'witness-ablation-'));
mkdirSync(out,{recursive:true});
const sentence='Saving uses an observed source witness to avoid silently overwriting outside changes. ';
const original=await Bun.file(join(parent,'original-file-editing-request.md')).text();
if(original.split(sentence).length!==2)throw new Error('Expected exactly one witness prescription');
const request=original.replace(sentence,'');
await Bun.write(join(out,'request-before.md'),original);
await Bun.write(join(out,'request-after.md'),request);
await Bun.write(join(out,'request-change.diff'),'--- request-before.md\n+++ request-after.md\n@@\n- Accepted input survives component unmounts, failed saves, conflicts, and newer typing during a save. Saving uses an observed source witness to avoid silently overwriting outside changes. Holding input in memory is distinct from durable crash recovery.\n+ Accepted input survives component unmounts, failed saves, conflicts, and newer typing during a save. Holding input in memory is distinct from durable crash recovery.\n');
const hash=(bytes:string|ArrayBuffer)=>new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const jobs=[];const fingerprints=[];const controls=[];
for(const skill of ['rethink','adversarial-review'])for(const repeat of [1,2]){
 const variants=crypto.getRandomValues(new Uint8Array(1))[0]%2?['old','revised']:['revised','old'];
 for(const [index,variant]of variants.entries()){
  const previous=old.jobs.find((j:any)=>j.skill===skill&&j.task==='file-editing'&&j.repeat===repeat&&j.variant===variant);
  if(!previous)throw new Error('Missing paired old run');
  const id=crypto.randomUUID().slice(0,8);const cwd=join(root,id);mkdirSync(cwd,{recursive:true});
  const sourceFiles=files.filter((x:any)=>x.run===previous.id);
  for(const file of sourceFiles){
   const source=join(previous.cwd,file.path);const bytes=await Bun.file(source).arrayBuffer();
   if(hash(bytes)!==file.sha256)throw new Error('Historical input changed: '+source);
   const destination=join(cwd,file.path);mkdirSync(join(destination,'..'),{recursive:true});
   if(file.path==='REQUEST.md'){
    const text=await Bun.file(source).text();if(text.split(sentence).length!==2)throw new Error('REQUEST expected one witness sentence');
    await Bun.write(destination,text.replace(sentence,''));
   }else copyFileSync(source,destination);
   const copied=await Bun.file(destination).arrayBuffer();fingerprints.push({run:id,path:file.path,sha256:hash(copied),bytes:copied.byteLength});
  }
  const init=Bun.spawn(['git','init','-q',cwd]);if(await init.exited)throw new Error('git init');
  const label=index===0?'A':'B';const prefix=`${skill}-file-editing-r${repeat}-${label}`;
  await Bun.write(join(out,prefix+'.prompt.txt'),previous.prompt);
  jobs.push({id,cwd,skill,task:'file-editing',repeat,variant,label,prefix,prompt:previous.prompt,originalRun:previous.prefix,skillHash:previous.skillHash});
  controls.push({run:id,pairedPriorRun:previous.id,changes:['REQUEST.md: deletion of one sentence'],allOtherInputsVerified:true});
 }
}
const pairChecks=[];
for(const skill of ['rethink','adversarial-review'])for(const repeat of [1,2]){
 const pair=jobs.filter(j=>j.skill===skill&&j.repeat===repeat);
 const a=new Map(fingerprints.filter(x=>x.run===pair[0].id).map(x=>[x.path,x.sha256]));
 const b=new Map(fingerprints.filter(x=>x.run===pair[1].id).map(x=>[x.path,x.sha256]));
 const changed=[...new Set([...a.keys(),...b.keys()])].filter(x=>a.get(x)!==b.get(x)).sort();
 const expected=[`.agents/skills/${skill}/SKILL.md`,...(skill==='adversarial-review'?['.agents/skills/adversarial-review/references/example-workflow.md']:[])].sort();
 if(JSON.stringify(changed)!==JSON.stringify(expected))throw new Error('Pair differs outside skill treatment');
 pairChecks.push({skill,repeat,changed});
}
await Bun.write(join(out,'private-manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),baseline:old.baseline,parentExperiment:parent,root,model:old.model,effort:old.effort,repetitions:2,condition:'one bundled witness/overwrite-protection sentence deleted; no replacement or solution hint',jobs},null,2));
await Bun.write(join(out,'input-fingerprints.json'),JSON.stringify(fingerprints,null,2));
await Bun.write(join(out,'input-isolation-check.json'),JSON.stringify({result:'pass',crossCondition:controls,withinCondition:pairChecks},null,2));
const protocol=`# Source-witness prescription ablation\n\nFrozen before execution. This extends [the initial experiment](../2026-10-22-greenfield-models/RESULTS.md). Eight new read-only Claude Opus 5.5 high sessions: two skills × frozen old/revised versions × two repetitions. The generation prompt, output target (1600 words), source files, supporting instructions, launcher invocation, and global Claude instructions are held as in the prior file-editing runs. There are no resumes, previous answers, eventual solution, or preferred design in the run directories or prompts. Only the request sentence shown in [the exact diff](request-change.diff) is deleted.\n\nThe deletion removes both a mechanism (source witness) and its bundled no-silent-overwrite guarantee. This cannot isolate the mechanism's wording from that guarantee. It does not introduce a different requirement or hint toward a particular write policy. The remaining prompt still mentions conflict scenarios and gives API proposals, and the frozen historical source still implements guarded writes. It is an ablation of one explicit prescription, not an unanchored problem statement.\n\nEach run has a fresh isolated Git root. Inputs were verified against the previous experiment's frozen file hashes. Within each new old/revised pair, only the skill treatment files differ. Across conditions for a given skill/version/repetition, only REQUEST.md differs, by exactly that deletion. Supporting rethink stays at baseline in both adversarial arms. Adversarial-review is tested as a delegated reviewer, not a panel. A/B identities are independently randomized per pair and held in the private manifest.\n\n## Questions and criteria set before execution\n\n1. Does a response independently develop a different, simpler organizing model, or mostly rearrange the existing buffer/storage model? Distinguish a concrete alternative from a passing suggestion.\n2. What does the proposed saving operation promise under outside modification, deletion and newer local input? Which promises come from the request, and which does the response choose or inherit?\n3. What machinery, concepts, coordination, or obligations disappear, and what work or loss is introduced? Removing checks alone is not a quality score.\n4. Are accepted-input retention, failure handling, revision-bounded save/flush, and the concrete vanilla/Svelte use coherent? Requirements still present must be respected or explicitly proposed for change.\n\nNo particular eventual solution is supplied to participants or blind judges. Guarded publication can remain the strongest design if grounded in the desired use; a simpler write policy must explain its consequences. Two repetitions per skill/version provide a small variability check, not statistical confidence. Comparison to the earlier batch is exploratory: the model responses are fresh, not replayed with deterministic seeds.\n\nFresh version-blind judges will compare old/revised answers per skill, reading the modified request and evidence but no skill versions or prior outcomes. They will assess model simplicity and quality separately. Afterward the coordinator will compare observed contracts with the prior batch and verify deciding quotes. Native JSON, sessions, actual models, denials, errors, exact inputs and results are retained. No production code or skill wording is changed.\n`;
await Bun.write(join(out,'PROTOCOL.md'),protocol);
let runner=await Bun.file(join(parent,'run-greenfield-eval.ts')).text();runner=runner.replaceAll(parent,out);await Bun.write(join(out,'run.ts'),runner);
copyFileSync('/tmp/prepare-witness-ablation.ts',join(out,'prepare.ts'));
console.log(JSON.stringify({out,root,jobs:jobs.length,verifiedInputFiles:fingerprints.length,pairChecks:pairChecks.length}));
