/** Tiny generated PDF with an identity Unicode map. Synthetic prices only. */
export function syntheticTariffPdf(input='15,86',output='61,00'){
 const rows=['Evolution Foundation Models','Цена с НДС*, руб. НДС* (22%), руб.',
  `271. БЯМ gpt-oss-120b входные токены млн шт месяц ${input==='15,86'?'13,00 2,86':'20,00 4,40'} ${input}`,
  `272. БЯМ gpt-oss-120b генерируемые токены млн шт месяц ${output==='61,00'?'50,00 11,00':'100,00 22,00'} ${output}`];
 const content=rows.map((s,i)=>'BT /F1 10 Tf 20 '+(780-i*20)+' Td <'+Array.from(s).map(c=>c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'> Tj ET').join('\n');
 const cmap='/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Synthetic def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0000> <FFFF> <0000> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type0 /BaseFont /Synthetic /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
  '<< /Length '+content.length+' >>\nstream\n'+content+'\nendstream',
  '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Synthetic /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 /CIDToGIDMap /Identity >>',
  '<< /Length '+cmap.length+' >>\nstream\n'+cmap+'\nendstream'];
 let value='%PDF-1.4\n';const offsets:number[]=[];
 for(const [i,object]of objects.entries()){offsets.push(value.length);value+=(i+1)+' 0 obj\n'+object+'\nendobj\n';}
 const xref=value.length;value+='xref\n0 8\n0000000000 65535 f \n'+offsets.map(n=>n.toString().padStart(10,'0')+' 00000 n \n').join('');
 return Buffer.from(value+'trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n');
}
