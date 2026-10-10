import {zipSync,strToU8} from 'fflate';
export const syntheticCsv='Банк;Т-Банк\nНомер счета;00000000000000000001\nДата операции;Сумма операции;Валюта;Описание\n2026-09-01;-10.01;RUB;Покупка OZON Private-Identifier\n2026-09-02;20.00;RUB;Возврат покупки OZON';
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
export function syntheticXlsx(extra:{formula?:boolean;external?:boolean;numericDate?:boolean;corrupt?:boolean;extraSheet?:boolean}={}){
 const rows=[['Банк','Т-Банк'],['Номер счета','00000000000000000001'],['Дата операции','Сумма операции','Валюта','Описание'],['2026-09-01','-10.01','RUB','Покупка OZON Private-Identifier'],['2026-09-02','20','RUB','Возврат покупки OZON']];
 const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
 const worksheet=`<worksheet xmlns="${ns}"><sheetData>${rows.map((r,n)=>`<row r="${n+1}">${r.map((v,c)=>n===3&&c===1&&extra.formula?'<c r="B4"><f>1+1</f><v>2</v></c>':n===3&&c===0&&extra.numericDate?'<c r="A4" s="1"><v>46266</v></c>':`<c r="${String.fromCharCode(65+c)}${n+1}" t="inlineStr"><is><t>${escape(v)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
 const files:Record<string,Uint8Array>={
  '[Content_Types].xml':strToU8('<Types/>'),
  'xl/workbook.xml':strToU8(`<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Synthetic" sheetId="1" r:id="rId1"/>${extra.extraSheet?'<sheet name="Other" sheetId="2" r:id="rId2"/>':''}</sheets></workbook>`),
  'xl/_rels/workbook.xml.rels':strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="${extra.external?'https://private.example.test/':'worksheets/sheet1.xml'}" ${extra.external?'TargetMode="External"':''}/>${extra.extraSheet?'<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>':''}</Relationships>`),
  'xl/worksheets/sheet1.xml':strToU8(extra.corrupt?worksheet.replace('<sheetData>','<!DOCTYPE secret><sheetData>'):worksheet),
  'xl/styles.xml':strToU8(`<styleSheet xmlns="${ns}"><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`),
 };
 if(extra.extraSheet)files['xl/worksheets/sheet2.xml']=strToU8(worksheet);
 return zipSync(files);
}
