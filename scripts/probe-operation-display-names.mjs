/** Observe frozen existing functions on synthetic names; not the future NAME formatter.
 * No model/network/DB calls. A mismatched source snapshot fails before imports.
 */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.length!==0&&(args.length!==2||args[0]!=='--source-root'))throw Error('USAGE: optional --source-root PATH');
const sourceRoot=args.length?resolve(args[1]):repoRoot;
const design=JSON.parse(await readFile(resolve(repoRoot,'docs/architecture/operation-display-names-20261028.json'),'utf8'));
for(const input of design.frozen_sources){
 const bytes=await readFile(resolve(sourceRoot,input.path));
 const sha=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
 if(sha!==input.blob)throw Error('FROZEN_SOURCE_MISMATCH: '+input.path);
}
const {recognizeMerchant}=await import(pathToFileURL(resolve(sourceRoot,'packages/finance-core/src/merchant-recognition.ts')).href);
const {bankDescription}=await import(pathToFileURL(resolve(sourceRoot,'packages/imports/src/bank-description.ts')).href);
const {extractSafeSource,sourceFields,descriptionSourceSanitizer}=await import(pathToFileURL(resolve(sourceRoot,'packages/imports/src/safe-source.ts')).href);
const inputs=['Кафе Москва','Магазин Россия','Столовая Иннополис','Кафе Москва RUS','OZON FRESH MOSCOW RUS','Пятёрочка доставка Москва Рус','Яндекс Маркет доставка','Timeweb.cloud Innopolis Rus','World Class Moscow Rus','XFit MOSCOW RUS','ИП Иванов Иван 24','СБЕР 24 Москва Рус','Аптека 36,6'];
const observations=inputs.map((input,i)=>{
 const r=recognizeMerchant(input);
 return {id:'NAME-B'+String(i+1).padStart(2,'0'),kind:'recognition',input,result:{name:r.name,brand:r.brand??null,service:r.service,delivery:r.delivery,conflict:r.conflict}};
});
observations.push({id:'NAME-B14',kind:'bank-description',input:{description:'Оплата услуг бюро переводов',merchant:'Бюро переводов Север'},result:bankDescription('Оплата услуг бюро переводов','Бюро переводов Север')});
const raw=extractSafeSource('Покупка PYATEROCHKA MOSCOW RUS','-10000',descriptionSourceSanitizer);
observations.push({id:'NAME-B15',kind:'source-fields',input:'Покупка PYATEROCHKA MOSCOW RUS',result:{detailsMerchant:raw?.details?.merchantText??null,fields:sourceFields(raw)}});
const baselineChecks=[
 {id:'NAME-I01',observation_refs:['NAME-B01','NAME-B02','NAME-B03','NAME-B04'],observed_risk:observations[0].result.name==='Кафе'&&observations[1].result.name==='Магазин',meaning:'Unproven city/country can be lost from an unknown name.'},
 {id:'NAME-I02',observation_refs:['NAME-B05'],observed_risk:!observations[4].result.name.toLowerCase().includes('fresh'),meaning:'Specific Fresh qualifier is lost by the broad Ozon display match.'},
 {id:'NAME-I03',observation_refs:['NAME-B12'],observed_risk:observations[11].result.name==='Москва',meaning:'Unknown unsegmented name can be reduced by generic prefix plus geo trimming.'},
 {id:'NAME-I04',observation_refs:['NAME-B14'],observed_risk:observations[13].result.merchantText==='',meaning:'Commercial translation merchant is suppressed by the substring перевод.'},
 {id:'NAME-I05',observation_refs:['NAME-B15'],observed_risk:observations[14].result.detailsMerchant==='PYATEROCHKA MOSCOW RUS'&&observations[14].result.fields.merchantText==='Пятёрочка',meaning:'Source-fields projection can change the alphabet before NAME.'},
];
console.log(JSON.stringify({audit:'cashneuro-name-existing-functions/1',status:'BASELINE_OBSERVATIONS_RECORDED_NOT_A_NAME_IMPLEMENTATION',baseline_commit:design.baseline_commit,source_files_verified:design.frozen_sources.length,synthetic_inputs:observations.length,observations,baselineChecks,control_observations:['NAME-B08','NAME-B09','NAME-B10','NAME-B11','NAME-B13'],integration_requirement:'NAME-I06 is a separate compatibility requirement, not a reproduced bug fixed by this probe.',future_name_product_tests:'NOT_RUN',ui_tests:'NOT_RUN',model_tests:'NOT_RUN',new_paid_calls:0,source_or_database_writes:0},null,2));
