import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const repo='/Users/braden/Code/epicenter';
const out=join(repo,'.agents/skills/skills-and-instructions/evals/runs/2026-10-22-greenfield-models');
const root=mkdtempSync(join(tmpdir(),'model-comparison-'));
const archive='/Users/braden/.codex/archived_sessions/rollout-2026-10-22T00-48-27-01a15f5d-3946-70f3-b26b-e02b33b37e1d.jsonl';
const rows=(await Bun.file(archive).text()).trim().split('\n').map(x=>JSON.parse(x));
const original=rows[14].payload.content.map((x:any)=>x.text??'').join('\n');
const historical=rows[132].payload.item.aggregated_output.trim();
async function git(args:string[]){const p=Bun.spawn(['git','-C',repo,...args],{stdout:'pipe',stderr:'pipe'});const result=await new Response(p.stdout).text();if(await p.exited)throw new Error(await new Response(p.stderr).text());return result;}
const baseline=(await git(['rev-parse','HEAD'])).trim();
const sha=(s:string)=>new Bun.CryptoHasher('sha256').update(s).digest('hex');
const common=['dialectic','writing-voice','post-implementation-review','asymmetric-wins','refactoring','svelte','typescript'];
const commonFiles:Record<string,string>={};
for(const name of [...common,'rethink','adversarial-review']){
 const paths=(await git(['ls-tree','-r','--name-only',baseline,'--',`.agents/skills/${name}`])).trim().split('\n').filter(x=>x.endsWith('.md'));
 for(const path of paths)commonFiles[path]=await git(['show',`${baseline}:${path}`]);
}
const old:Record<string,string>={};const revised:Record<string,string>={};
for(const name of ['rethink','adversarial-review']){
 const path=`.agents/skills/${name}/SKILL.md`;
 old[path]=commonFiles[path];revised[path]=await Bun.file(join(repo,path)).text();
}
const example='.agents/skills/adversarial-review/references/example-workflow.md';
old[example]=commonFiles[example];revised[example]=await Bun.file(join(repo,example)).text();
mkdirSync(join(out,'frozen'),{recursive:true});
for(const [variant,files] of Object.entries({old,revised}))for(const [path,s]of Object.entries(files)){const destination=join(out,'frozen',variant,path);mkdirSync(join(destination,'..'),{recursive:true});await Bun.write(destination,s);}
await Bun.write(join(out,'original-file-editing-request.md'),original);
const photo=`Help me rethink a photo-import API from first principles. This is conceptual exploration, not implementation. Don't let the current proposal or migration cost determine the destination.

People import photos from a phone, a local folder, and an archive export. They often select overlapping sets at different times. A selection can contain 80,000 files, including large videos. Closing the screen or restarting the application must not lose completed work or the person's decisions. Some sources are removable drives; browser selections may require the person to grant access again after restart. Do not assume an operating-system path is a durable credential.

The product must preserve every distinct original byte sequence, avoid storing identical bytes repeatedly, and preserve source provenance including different filenames and capture metadata. Equal bytes can appear under different names; the same filename can refer to different bytes. A photo that cannot be decoded still needs its original preserved and a visible problem report. People want to start using successfully imported items while the rest continues. They can pause, cancel remaining work, retry failures, and later reselect a source. Cancellation must not silently delete items already imported. A failed preview is not proof that the original failed to copy.

The current proposal is:

type ImportSession = {
  id: string;
  sourceId: string;
  manifestId: string;
  status: 'selected' | 'scanning' | 'copying' | 'processing' | 'ready' | 'failed' | 'cancelled';
  entries: ImportEntry[];
};

type ImportEntry = {
  id: string;
  sourcePath: string;
  destinationPath?: string;
  copyStatus: 'pending' | 'copying' | 'copied' | 'failed';
  decodeStatus: 'pending' | 'processing' | 'done' | 'failed';
  duplicateOf?: string;
};

The implementation sketch puts SourceRegistry, ManifestStore, CopyQueue, DuplicateIndex, PreviewQueue, and ImportSessionStore behind an ImportManager. Each queue persists its progress and sends completion callbacks to the manager. A separate AssetStore owns imported files and MetadataStore owns their interpretation. No implementation exists yet; these are proposed boundaries, not requirements.

Different consumers need a progress screen, a library grid that displays usable imported items, a source-reconnection prompt, and per-file diagnostics. A background process may continue work while none of those screens is mounted. Raw source metadata should remain available even if the current parser does not understand it.

Develop the strongest coherent greenfield model and API. Show natural use and a realistic UI interaction. Follow a batch through partial success, restart with a missing source, reselecting overlapping files, a preview failure after a successful copy, and cancellation followed by retry. Define what an import's completion promises. Explain the information and responsibilities that belong together, what disappears, what new work or concepts you introduce, and which user guarantees justify them. You may challenge explicit requirements as clearly labeled proposals, but do not silently discard them.
`;
await Bun.write(join(out,'photo-import-request.md'),photo);
const adapter=`Environment note: this is a frozen, read-only source snapshot. The historical absolute workspace path in the request maps to this checkout. Thread-reading tools are unavailable; do not substitute live repository or conversation state. Relevant historical source and callers are included under packages/ and apps/. The original request is reproduced without the later discussion. Describe implementation only as observed in this snapshot.\n\n`;
const jobs:any[]=[];
for(const skill of ['rethink','adversarial-review'])for(const task of ['file-editing','photo-import'])for(let repeat=1;repeat<=2;repeat++){
 const variants=Math.random()<.5?['old','revised']:['revised','old'];
 for(const [index,variant] of variants.entries()){
  const id=crypto.randomUUID().slice(0,8);const cwd=join(root,id);mkdirSync(cwd,{recursive:true});
  for(const [path,s]of Object.entries(commonFiles)){
   if(path.startsWith('.agents/skills/adversarial-review/')&&skill!=='adversarial-review')continue;
   const destination=join(cwd,path);mkdirSync(join(destination,'..'),{recursive:true});await Bun.write(destination,s);
  }
  const active=`.agents/skills/${skill}/SKILL.md`;await Bun.write(join(cwd,active),variant==='old'?old[active]:revised[active]);
  if(skill==='adversarial-review')await Bun.write(join(cwd,example),variant==='old'?old[example]:revised[example]);
  if(task==='file-editing')for(const path of ['packages','apps'])cpSync(join(historical,path),join(cwd,path),{recursive:true});
  await Bun.write(join(cwd,'REQUEST.md'),task==='file-editing'?adapter+original:photo);
  const init=Bun.spawn(['git','init','-q',cwd]);if(await init.exited)throw new Error('git init failed');
  const prompt=`Read .agents/skills/${skill}/SKILL.md and apply it to REQUEST.md. ${skill==='adversarial-review'?'You are the delegated independent reviewer; perform the review yourself.':'Develop the initial substantive proposal for the user.'} Read the relevant supplied evidence and references. Return your finished conceptual answer, including concrete use and the consequential sequences requested. Keep it within 1600 words. Do not edit files, run commands, ask for a follow-up before giving the substantive answer, or launch agents.\n`;
  const prefix=`${skill}-${task}-r${repeat}-${index===0?'A':'B'}`;
  await Bun.write(join(out,`${prefix}.prompt.txt`),prompt);
  jobs.push({id,cwd,skill,task,repeat,variant,label:index===0?'A':'B',prefix,prompt,skillHash:sha(variant==='old'?old[active]:revised[active])});
 }
}
await Bun.write(join(out,'private-manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),baseline,root,historicalSnapshot:historical,model:'claude-opus-5-5',effort:'high',mode:'consult/read-only; adversarial delegated reviewer only',repetitions:2,commonSupport:'Git HEAD markdown files; rethink held at HEAD for both adversarial arms',requests:{file:sha(original),photo:sha(photo)},snapshots:Object.fromEntries(Object.entries({old,revised}).map(([v,files])=>[v,Object.fromEntries(Object.entries(files).map(([p,s])=>[p,sha(s)]))])),jobs},null,2));
const protocol=`# Greenfield model comparison\n\nFrozen before execution. Two skills, two task prompts, old versus revised, two independent repetitions: 16 new Claude Opus 5.5 high sessions. Each run has a separate Git root outside the live repositories. Active skill and its changed example are the treatment. Supporting Markdown is held constant at ${baseline}; adversarial-review uses the baseline rethink in both arms to isolate its own effect. File-editing sources come from the source snapshot retained during the original discussion, before its later solution. The exact opening request is retained; only an environment note maps its absolute workspace to the isolated snapshot and explains unavailable thread tools. Earlier thread context is unavailable, so this is not a complete replay of the original session. Photo import is a synthetic held-out design problem with no existing implementation. Seat booking was excluded because it shaped the revision.\n\nThe same read-only launcher, model, effort, global Claude instructions, output allowance (1600 words), and single-turn task are used in every arm. No session resumes, helper agents, live repository access, later discussion, solution hints, or prior outputs are supplied. This tests an initial rethink proposal and the delegated-reviewer reasoning of adversarial-review, not a full live dialectic or its multi-reviewer coordination. A/B order is independently randomized per pair; the private manifest records the key.\n\n## Criteria set before execution\n\nCompare independent formation of a coherent model; concrete operations and lifecycle consequences; handling of explicit requirements or clearly labeled proposed changes; necessary distinctions versus hidden or displaced complexity; and useful next decisions supported by supplied evidence. File case additionally checks typing/save overlap, revert/retry/conflict/deletion, bounded save/flush semantics, and usable vanilla/Svelte expression. Photo case checks byte identity versus provenance, original preservation independent of preview, durable progress versus source permission, overlapping reselection, cancellation/retry, and precise completion meaning.\n\nNo points for reproducing the eventual file solution. A stronger abstraction, retention, or deletion can win. Silently dropping explicit requirements is a regression. More alternatives, longer output, reviewer agreement, or fewer named types do not establish improvement. Two repetitions provide a small variability check, not statistical confidence or generalization.\n\nNative JSON, session IDs, model usage, denials, errors, prompts, frozen treatment files, and answer Markdown are retained. A timeout, truncation, or blocked evidence read is incomplete evidence, not a passing result. Blind comparison receives task, criteria, and A/B outputs without the version key.\n`;
await Bun.write(join(out,'PROTOCOL.md'),protocol);
console.log(JSON.stringify({out,root,jobs:jobs.length,baseline,historicalSnapshot:historical}));
