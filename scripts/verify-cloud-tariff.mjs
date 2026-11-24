// Public tariff preflight only. No key loader, database, model POST or config edit.
import {verifyClassificationTariff} from '../apps/api/src/classification-tariff.ts';
try {
 const result=await verifyClassificationTariff(fetch);
 console.log(JSON.stringify({step:'cloud-tariff',ok:true,paidCalls:0,...result}));
} catch(error) {
 const code=error instanceof Error&&/^CLASSIFICATION_TARIFF_[A-Z_]+$/.test(error.message)?error.message:'CLASSIFICATION_TARIFF_UNAVAILABLE';
 console.log(JSON.stringify({step:'cloud-tariff',ok:false,code,paidCalls:0}));process.exitCode=1;
}
