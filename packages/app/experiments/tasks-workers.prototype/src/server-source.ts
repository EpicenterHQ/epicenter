// Supplied as raw TypeScript to the runtime bundler along with the actual Tasks action file.
export const serverSource = `
import { WorkerEntrypoint } from 'cloudflare:workers';
import { parse } from 'yaml';
import { inRun, runYielding, ActionError } from '@epicenter/app';
import app from './epicenter.ts';
(globalThis as any).Bun = { YAML: { parse } };
export class Actions extends WorkerEntrypoint {
  describe() { return Object.keys(app.actions); }
  async run(name: string, input: unknown, storage: any) {
    const action = (app.actions as any)[name];
    if (!action) return { error: { name: 'Missing', message: 'Unknown action' } };
    const folder = {
      read: async (path: string) => (await storage.peek(path)).text ?? undefined,
      readBytes: async (path: string) => { const text=(await storage.peek(path)).text; return text===null?undefined:new TextEncoder().encode(text); },
      write: (path: string, text: string) => storage.write(path,text),
      writeBytes: (path: string, bytes: Uint8Array) => storage.write(path,new TextDecoder().decode(bytes)),
      delete: (path: string) => storage.remove(path),
      list: (dir?: string) => storage.list(dir),
      update: async (path: string, change: (text?: string)=>string) => {
        for(let n=0;n<10;n++) { const before=await storage.peek(path); const text=change(before.text??undefined); if(text===before.text) return text; if(await storage.replace(path,before.version,text)) return text; }
        throw ActionError.Changed({path,why:'kept'}).error;
      },
    };
    try { return { returned: await inRun({folder,signal:new AbortController().signal,...(action.annotations?.readOnlyHint?{readOnly:{action:name}}:{})},()=>runYielding(action,input,()=>{})) }; }
    catch(error) { return { threw: { message: error instanceof Error?error.message:String(error) } }; }
  }
}
`;
