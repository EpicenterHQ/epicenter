// Raw TypeScript compiled in Workers against the copied, current 0.4 runtime.
export const serverSource = `
import { WorkerEntrypoint } from 'cloudflare:workers';
import { parse } from 'yaml';
import { Type } from 'typebox';
import { inRun, runYielding, ActionError, Ok } from '@epicenter/app';
import app from './epicenter.ts';
import {encodeActionResult} from './runtime/src/action-result.ts';
(globalThis as any).Bun = { YAML: { parse } };
function table(actions: any, prefix=''): any {
 return Object.assign({}, ...Object.entries(actions).map(([name,value])=> typeof value==='function'?{[prefix+name]:value}:table(value,prefix+name+'.')));
}
const actions=table(app.actions);
export class Actions extends WorkerEntrypoint {
 describe(){return Object.fromEntries(Object.entries(actions).map(([name,action]:any)=>[name,{schema:Type.Object(action.input,{additionalProperties:false}),privateInput:action.privateInput??false}]));}
 async run(name:string,input:unknown,storage:any,sink:any){
  const action=actions[name];
  const controller=new AbortController();
  const watching=sink.whenCancelled().then((cancelled:boolean)=>{if(cancelled)controller.abort(new Error('The run was cancelled'));},()=>controller.abort(new Error('The host interrupted this run')));
  const edit=async(path:string,decide:any)=>{
   for(let n=0;n<10;n++){
    const before=await storage.peek(path);const result=decide(before.text??undefined);
    if(result.error!==null)return result;
    const {value,text}=result.data;
    if(text===undefined||text===before.text)return Ok(value);
    if(await storage.replace(path,before.version,text))return Ok(value);
   }
   return ActionError.Changed({path,why:'kept'});
  };
  const folder={
   edit,
   read:async(path:string)=>(await storage.peek(path)).text??undefined,
   readBytes:async(path:string)=>{const text=(await storage.peek(path)).text;return text===null?undefined:new TextEncoder().encode(text);},
   write:(path:string,text:string)=>storage.write(path,text),
   writeBytes:(path:string,bytes:Uint8Array)=>storage.write(path,new TextDecoder().decode(bytes)),
   delete:(path:string)=>storage.remove(path),list:(dir?:string)=>storage.list(dir),
   update:async(path:string,change:any)=>{const result=await edit(path,(before:any)=>{const text=change(before);return Ok({value:text,text});});if(result.error)throw result.error;return result.data;},
  };
  try{
   const result=encodeActionResult(await inRun({folder,signal:controller.signal,...(action.annotations?.readOnlyHint?{readOnly:{action:name}}:{})},()=>runYielding(action,input,async(value:any)=>{controller.signal.throwIfAborted();await sink.yield(value);})) );
   return result.error===null?{data:result.data??null,error:null}:{data:null,error:{kind:'returned',reason:result.error}};
  }catch(error){let thrown;try{if(error&&typeof error==='object'&&!(error instanceof Error)&&typeof error.name==='string'&&typeof error.message==='string')thrown=JSON.parse(JSON.stringify(error));}catch{}return {data:null,error:{kind:'fault',message:(()=>{try{return (typeof (error as any)?.message==='string'?(error as any).message:String(error)).slice(0,4096);}catch{return 'The action threw an unreadable value';}})(),...(thrown?{thrown}:{})}};}
  finally{try{await sink.releaseCancellation();}catch{}void watching;}
 }
}
`;
