import {createRequire} from 'node:module';
import {copyFile,mkdir,readdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Generated exclusively from pinned lockfile packages; no CDN or live model download.
const web=fileURLToPath(new URL('../apps/web/',import.meta.url)),require=createRequire(join(web,'package.json'));
const target=join(web,'public/ocr-v1');await mkdir(target,{recursive:true});
const tess=dirname(require.resolve('tesseract.js/package.json')),core=dirname(createRequire(join(tess,'package.json')).resolve('tesseract.js-core/package.json'));
await copyFile(join(tess,'dist/worker.min.js'),join(target,'worker.min.js'));
for(const name of await readdir(core))if(/^tesseract-core.*-lstm\.wasm(?:\.js)?$/.test(name))await copyFile(join(core,name),join(target,name));
for(const lang of ['rus','eng']){
 const base=dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
 await copyFile(join(base,'4.0.0_best_int',`${lang}.traineddata.gz`),join(target,`${lang}.traineddata.gz`));
}
await copyFile(join(tess,'LICENSE'),join(target,'TESSERACT-LICENSE.txt')).catch(async()=>copyFile(join(tess,'LICENSE.md'),join(target,'TESSERACT-LICENSE.txt')));
