import type {Kind} from '../../finance-core/src/model.ts';

// Explicit statement wording only. A merchant mention, category or amount sign
// alone never establishes a purchase or the economic purpose of a transfer.
const sberCategory='Коммунальные платежи, связь, интернет\.|Прочие платежи, переводы, услуги\.|Супермаркеты|Рестораны и кафе|Транспорт|Здоровье и красота|Одежда и обувь|Дом и ремонт|Развлечения|Связь и телекоммуникации';
const sberCard=new RegExp('^('+sberCategory+')\\s+(.+?)\\.?\\s+Операция по карте(?=$|[^\\p{L}\\p{N}]).*$', 'iu');
const city='(?:MOSCOW|MOSKVA|МОСКВА|SAINT[ -]PETERSBURG|SANKT[ -]PETERBURG|САНКТ-ПЕТЕРБУРГ|INNOPOLIS|ИННОПОЛИС)';
export const bankCityTail=new RegExp('(?:[ ,]+'+city+')+$', 'iu');
const cityHead=new RegExp('^'+city+'\\s+', 'iu');
export function statementPayment(text:string):{merchantText:string;bankCategory:string}|null{
 const s=text.normalize('NFKC').replace(/\s+/g,' ').trim();
 if(/\p{Cf}/u.test(s))return null;
 const ozon=/^Оплата товаров по (?:(?:кредитной|дебетовой) )?карте .+? сумма \d[\d .,]* в (.+?) дата \d{4}\s*-\s*\d{2}\s*-\s*\d{2}(?:\s|$)/iu.exec(s);
 if(ozon)return {merchantText:ozon[1]!,bankCategory:''};
 const platform=/^Оплата товаров\/услуг на (?:маркетплейсе|платформе|сайте) (Ozon)(?=$|[^\p{L}\p{N}])/iu.exec(s);
 if(platform)return {merchantText:platform[1]!,bankCategory:''};
 const card=sberCard.exec(s);
 if(card)return {merchantText:card[2]!.split(/\s+Покупка по СБП в /iu)[0]!.replace(cityHead,'').replace(/\.$/u,'').trim(),bankCategory:card[1]!};
 const sbpNamed=/^([^.]+[.]?)\s+(.+?)\s+Покупка по СБП в (?:ТСТ|приложении|терминале|торговой).+?(?:Операция по карте|$)/iu.exec(s);
 if(sbpNamed&&/платежи|связь|услуги/iu.test(sbpNamed[1]!))return {merchantText:sbpNamed[2]!.trim(),bankCategory:sbpNamed[1]!.replace(/\.$/u,'')};
 const sbp=(/^[\p{L}]+ платежи[, ]/iu.test(s)?/Покупка по СБП в (.+?)(?:\.\s*Операция по карте|$)/iu:/^Покупка по СБП в (.+?)(?:\.\s*Операция по карте|$)/iu).exec(s);
 if(sbp)return {merchantText:/приложении.*банка/iu.test(sbp[1]!)?'':sbp[1]!.replace(/\.+$/u,'').trim(),bankCategory:''};
 const payment=/^(?:Оплата товаров и услуг|Оплата покупки|Покупка(?: в)?|Оплата услуг|Оплата в|Оплата по карте|Оплата картой|Purchase|Card payment|Возврат покупки|Возврат средств за покупку|Возврат оплаты|Purchase refund|Refund)\s*[:.-]?\s+(.+)$/iu.exec(s);
 return payment?{merchantText:payment[1]!,bankCategory:''}:null;
}
export function statementEvent(text:string,amountMinor:string):Kind|null{
 if(!/^-?\d{1,19}$/.test(amountMinor)||/\p{Cf}/u.test(text))return null;
 const s=text.normalize('NFKC').replace(/\s+/g,' ').trim(),n=BigInt(amountMinor);
 if(!n||/^(?:не |ожидается |планируется |возврат перевода)/iu.test(s))return null;
 if(/^Отмена покупки(?=$|[^\p{L}\p{N}])/iu.test(s))return 'reversal';
 if(/^Погашение (?:кредитной карты|задолженности по кредитной карте)(?=$|[^\p{L}\p{N}])/iu.test(s)||/^Погашение кредита по /iu.test(s)&&/(?<![\p{L}\p{N}])[КK][КK]-/iu.test(s))return 'credit_card_repayment';
 if(/^(?:(?:Частичное|Досрочное) )?Погашение кредита(?=$|[^\p{L}\p{N}])/iu.test(s))return 'loan_payment';
 if(n<0n&&/^Погашение процентов(?:\.|$)/iu.test(s))return 'interest';
 if(/^(?:(?:внутренний|внешний|входящий|исходящий|денежный|банковский)\s+)?перевод(?=$|[^\p{L}\p{N}])/iu.test(s))return n>0n?'transfer_in':'transfer_out';
 if(n>0n&&/^(?:Пополнение(?:[ .:]|$)|(?:Возврат|Вывод) средств с (?:накопительного|брокерского|инвестиционного) счета(?=$|[^\p{L}\p{N}]))/iu.test(s))return 'transfer_in';
 if(n<0n&&/^Пополнение (?:накопительного счета|вклада|счета|счёта|инвесткопилки)(?=$|[^\p{L}\p{N}])/iu.test(s))return 'transfer_out';
 if(n>0n&&/^(?:К[еэ]шб[еэ]к|Вознаграждение за покупки)(?=$|[^\p{L}\p{N}])/iu.test(s))return 'cashback';
 if(n>0n&&/^(?:Возврат покупки|Возврат средств за покупку|Возврат оплаты|Purchase refund|Refund)(?=$|[^\p{L}\p{N}])/iu.test(s))return 'refund';
 if(n<0n&&/^Внесение наличных/iu.test(s))return null;
 if(n>0n&&/^Внесение наличных(?=$|[^\p{L}\p{N}])/iu.test(s))return 'cash_deposit';
 if(n<0n&&/^Снятие наличных(?=$|[^\p{L}\p{N}])/iu.test(s))return 'cash_withdrawal';
 if(n<0n&&/^Комиссия(?: банка| за|$)/iu.test(s))return 'fee';
 if(n<0n&&/^Доплата за (?:продление|подключение) рассрочки(?=$|[^\p{L}\p{N}])/iu.test(s))return 'fee';
 if(n<0n&&/^Плата за (?:обслуживание|перевод|оповещения|уведомления|пакет|страхование|пользование)(?=$|[^\p{L}\p{N}])/iu.test(s))return 'fee';
 if(n<0n&&statementPayment(s)&&!/^Возврат|^Refund|^Purchase refund/iu.test(s)&&!/^Оплата (?:услуг\s*[:.]?\s*)?(?:денежный перевод|перевод денежных средств)/iu.test(s))return 'purchase';
 return null;
}
