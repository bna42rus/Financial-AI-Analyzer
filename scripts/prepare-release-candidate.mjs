import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assistantRuntimeManifest} from '../apps/api/src/analyzer-assistant-manifest.ts';

const root=new URL('../',import.meta.url),directory=fileURLToPath(root);
const git=(...args)=>execFileSync('git',args,{cwd:directory,encoding:'utf8'}).trim();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const revision=process.env.CASHNEURO_CANDIDATE_REVISION??git('rev-parse','HEAD');
if(!/^[a-f0-9]{40}$/.test(revision)||git('rev-parse',revision+'^{commit}')!==revision||git('rev-parse',revision+'^{tree}')!==git('rev-parse','HEAD^{tree}'))throw Error('RELEASE_CANDIDATE_TREE_CHANGED');
execFileSync('git',['diff','--quiet','HEAD','--','.'],{cwd:directory});
const read=path=>readFile(new URL(path,root));
const primary=hash(await read('docs/product/master_spec_v1.pdf'));
if(primary!=='5255d758534e74c9329cb8437e8a862f4bf989999172903a862462294b4ce9c8')throw Error('RELEASE_PRIMARY_SPEC_CHANGED');
const manifest=await assistantRuntimeManifest(),source=await read('apps/api/src/assistant-workflow.ts'),match=/export const assistantWorkflowVersion = '([^']+)'/u.exec(source.toString());
if(!match)throw Error('RELEASE_WORKFLOW_MISSING');
const migrations={};
for(const name of ['0027_assistant_runtime.sql','0028_ai_classification.sql','0029_bank_description.sql','0030_marketplace_catalog.sql','0031_merchant_source.sql','0032_category_bindings.sql'])migrations[name]=hash(await read('packages/database/migrations/'+name));
let frontend=null;
try{frontend=JSON.parse(await read('apps/web/dist/release.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
const connected=frontend?.schema==='cashneuro-web-build/1'&&frontend?.mode==='connected'&&frontend?.profile==='finance'&&frontend?.apiOrigin==='https://test.cashneuro.ru'&&frontend?.revision===revision;
const assets={};
async function walk(base,relative=''){
 for(const entry of (await readdir(base,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
  const name=relative+entry.name,url=new URL(entry.name+(entry.isDirectory()?'/':''),base);
  if(entry.isDirectory())await walk(url,name+'/');
  else if(entry.isFile())assets[name]=hash(await readFile(url));
  else throw Error('RELEASE_ASSET_TYPE_INVALID');
 }
}
if(connected)await walk(new URL('apps/web/dist/',root));
const result={version:'cashneuro-release-candidate/1',revision,treeSha:git('rev-parse',revision+'^{tree}'),primarySpecSha256:primary,lockfileSha256:hash(await read('pnpm-lock.yaml')),assistant:manifest,workflow:match[1],worker:{sourceRevision:revision,entrySha256:hash(await read('apps/api/src/import-main.ts'))},migrations,frontend:{connected,manifest:frontend,assetCount:Object.keys(assets).length,assetsSha256:connected?hash(JSON.stringify(assets)):null,assets},paidCalls:0,modelAcceptance:'not_executed',stagingInstalled:false,productionApproved:false,rollback:{additiveMigrationsRetained:true,restoreOldDatabaseOverNewWrites:false,afterNewCalendarOrBindingsWrites:'compatible_forward_fix_required'}};
const action=process.argv[2]??'--prepare';
if(process.argv.length>3||!['--prepare','--check','--write'].includes(action))throw Error('RELEASE_PREPARE_ARGUMENTS_INVALID');
if(action==='--check'&&!connected)throw Error('RELEASE_CONNECTED_FRONTEND_REQUIRED');
if(action==='--write'){if(!connected)throw Error('RELEASE_CONNECTED_FRONTEND_REQUIRED');await mkdir(new URL('artifacts/',root),{recursive:true});await writeFile(new URL('artifacts/release-candidate.json',root),JSON.stringify(result,null,2)+'\n',{mode:0o600});}
console.log(JSON.stringify({...result,frontend:{...result.frontend,assets:undefined}},null,2));
