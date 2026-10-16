import { privateJson } from './kms.ts';
import { assistantRuntimeManifest } from './analyzer-assistant-manifest.ts';
import { configureAssistantStaging } from './analyzer-assistant-setup.ts';
import { AssistantError } from '../../../packages/analyzer/src/assistant-plan.ts';
async function main(){
 const [action,path,...extra]=process.argv.slice(2);
 if(extra.length || action==='--prepare'&&path || !['--prepare','--configure'].includes(action??''))throw new AssistantError('ASSISTANT_SETUP_ARGUMENTS_INVALID');
 if(action==='--prepare'){console.log(JSON.stringify(await assistantRuntimeManifest()));return;}
 if(!path)throw new AssistantError('ASSISTANT_SETUP_ARGUMENTS_INVALID');
 const input=await privateJson(path);
 console.log(JSON.stringify(await configureAssistantStaging(input,fetch)));
}
main().catch(error=>{console.error(error instanceof Error&&/^[A-Z][A-Z0-9_]{1,80}$/.test(error.message)?error.message:'ASSISTANT_SETUP_FAILED');process.exitCode=1;});
