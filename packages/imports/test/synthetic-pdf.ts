import type {PdfLayout} from '../src/bank-pdf.ts';
/** Small deterministic PDF test generator with explicit Unicode mapping, no fonts/downloads. */
export function syntheticPdf(layout:PdfLayout):Uint8Array{
 const chars=[...new Set(layout.flat().flatMap(i=>[...i.text]))],codes=new Map(chars.map((c,n)=>[c,n+1]));
 const hex=(n:number)=>n.toString(16).padStart(4,'0');
 const cmap=`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /TestUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chars.length} beginbfchar\n${chars.map(c=>`<${hex(codes.get(c)!)}> <${hex(c.charCodeAt(0))}>`).join('\n')}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
 const stream=(s:string)=>`<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
 const kids=layout.map((_,i)=>7+i*2),objects=[
  '<< /Type /Catalog /Pages 2 0 R >>',
  `<< /Type /Pages /Kids [${kids.map(n=>`${n} 0 R`).join(' ')}] /Count ${kids.length} >>`,
  '<< /Type /Font /Subtype /Type0 /BaseFont /Synthetic /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>',
  '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Synthetic /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 6 0 R /DW 500 /CIDToGIDMap /Identity >>',
  stream(cmap),
  '<< /Type /FontDescriptor /FontName /Synthetic /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>',
 ];
 for(const [i,page] of layout.entries()){
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 650 850] /Resources << /Font << /F1 3 0 R >> >> /Contents ${8+i*2} 0 R >>`);
  objects.push(stream(page.map(item=>`BT /F1 8 Tf 1 0 0 1 ${item.x} ${item.y} Tm <${[...item.text].map(c=>hex(codes.get(c)!)).join('')}> Tj ET`).join('\n')));
 }
 let pdf='%PDF-1.7\n',offsets=[0];for(const [i,obj] of objects.entries()){offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
 const xref=pdf.length;pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>n.toString().padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
 return new TextEncoder().encode(pdf);
}
