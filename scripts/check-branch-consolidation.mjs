import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const manifest = JSON.parse(await readFile(new URL('../docs/architecture/branch-consolidation-20261016.json',import.meta.url),'utf8'));
const git = (...args) => execFileSync('git',args,{cwd:new URL('../',import.meta.url),stdio:'pipe'}).toString().trim();
if(manifest.version!=='cashneuro-branch-consolidation/1'||manifest.remoteBranches.length!==48)throw Error('BRANCH_MANIFEST_INVALID');
for(const row of manifest.remoteBranches){
 if(!/^[a-f0-9]{40}$/.test(row.sha))throw Error('BRANCH_SHA_INVALID');
 git('merge-base','--is-ancestor',row.sha,'HEAD');
}
git('merge-base','--is-ancestor',manifest.auditedBase,'HEAD');
console.log('Все 48 исходных веток сохранены в истории общей сборки.');
