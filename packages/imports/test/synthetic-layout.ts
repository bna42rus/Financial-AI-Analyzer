// Artificial data only. These layouts contain no user statement rows.
import type {PdfLayout,TextItem} from '../src/bank-pdf.ts';
const item=(text:string,x:number,y:number):TextItem=>({text,x,y,width:text.length*4});
const account='00000000000000000001';
const common=(bank:string)=>[item(bank,50,800),item('Валюта: РОССИЙСКИЙ РУБЛЬ',50,780)];
export function syntheticLayout(bank:'tbank'|'ozon'|'sber'):PdfLayout{
 if(bank==='tbank')return [[...common('Т-Банк · Справка о движении средств'),item('Номер лицевого счета: '+account,50,750),
  item('Дата и время',50,700),item('Дата',120,700),item('Сумма в валюте',190,700),item('Сумма операции',290,700),item('Описание',390,700),item('Номер',500,700),item('карты',500,689),
  item('01.09.2026',50,650),item('02.09.2026',120,650),item('- 12.34 $',190,650),item('- 10.01 ₽',290,650),item('Sensitive recipient Private Person +7 000 000 00 00',390,650),item('0000',500,650),item('23:30',50,639),
  item('01.09.2026',50,600),item('02.09.2026',120,600),item('- 10.01 ₽',290,600),item('Sensitive text',390,600),item('23:30',50,589)]];
 if(bank==='sber')return [[...common('Сбербанк · Выписка по счёту дебетовой карты'),item('Номер счёта '+account,50,750),
  item('ДАТА ОПЕРАЦИИ (МСК)',50,700),item('СУММА В ВАЛЮТЕ СЧЁТА',370,700),item('ОСТАТОК СРЕДСТВ',490,700),item('Код авторизации',50,690),item('Описание операции',150,680),
  item('01.09.2026',50,650),item('23:30',100,650),item('Sensitive text',150,650),item('10,01',420,650),item('999,99',530,650),item('02.09.2026',50,639),item('123456',100,639),
  item('01.09.2026',50,600),item('23:30',100,600),item('Sensitive text',150,600),item('+ 10,01',420,600),item('02.09.2026',50,589),item('123456',100,589)]];
 return [[...common('ООО «ОЗОН Банк» · Справка о движении денежных средств'),item('Номер договора: № Synthetic-Account-A от 01.01.2026',50,750),
  item('Сумма операции',410,712),item('Дата операции',50,700),item('Документ',160,700),item('Назначение платежа',225,700),item('Валюта',452,689),
  item('01.09.2026',50,650),item('PrivateDocument1',160,650),item('Private recipient',225,650),item('- 10.01 ₽',390,650),item('- 99.99',495,650),item('23:30:01',50,639),
  item('01.09.2026',50,600),item('PrivateDocument1',160,600),item('Private recipient',225,600),item('+ 10.01 ₽',390,600),item('23:30:01',50,589),item('Дата и время операции указаны по московскому времени',50,550)]];
}
