import type {BankFact} from './model.ts';
import {statementPayment,bankCityTail} from '../../imports/src/bank-event.ts';
import {recognizeCatalogEvidence} from './catalog-evidence.ts';
import {catalogFold} from './catalog-lexical.ts';

/** A complete bank payment wrapper proves the city/channel/branch metadata.
 * Unknown trade names and manual names are never reduced to a brand substring. */
export function bankMerchantProjection(source:Pick<BankFact,'description'|'merchantText'|'versions'>&Partial<Pick<BankFact,'bankCategory'|'sourceMcc'>>):string|null{
 if(source.versions.sourceSanitizer!=='bank-source/5'||source.versions.sourceTextEvidence!=='intact')return null;
 // Metadata elision needs a specific bank template. Generic “Покупка NAME”
 // remains literal and cannot prove that NAME's city/number is metadata.
 if(!/^(?:Оплата в |Оплата товаров по |Оплата товаров\/услуг на |Супермаркеты |Рестораны и кафе |Транспорт )/iu.test(source.description))return null;
 const payment=statementPayment(source.description);if(!payment)return null;
 if(source.merchantText&&source.merchantText!==payment.merchantText.slice(0,160))return null;
 const raw=payment.merchantText.replace(/\s+(?:RU|RUS|RUSSIA|РОССИЯ)$/iu,'').replace(bankCityTail,'').trim();
 const candidate=raw.replace(/(?:_\d+(?:_[A-Z]+_\d+)?|\s+\d{3,6})$/iu,'').trim();
 const evidence=recognizeCatalogEvidence({merchantText:candidate,description:source.description,bankCategory:source.bankCategory,mcc:source.sourceMcc});
 if(evidence.status==='recognized'&&evidence.entry.aliases.some(a=>catalogFold(a)===catalogFold(candidate)))return candidate;
 return raw;
}
