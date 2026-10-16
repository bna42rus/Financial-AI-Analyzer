/** Synthetic raster-only PDF for actual local OCR checks. No user statement data. */
export function syntheticImagePdf(jpeg:Uint8Array,width=2000,height=1400){
 const encoder=new TextEncoder(),parts:Uint8Array[]=[],offsets=[0];let length=0;
 const append=(value:string|Uint8Array)=>{const bytes=typeof value==='string'?encoder.encode(value):value;parts.push(bytes);length+=bytes.length;};
 append('%PDF-1.4\n');
 const object=(id:number,body:string)=>{offsets[id]=length;append(`${id} 0 obj\n${body}\nendobj\n`);};
 object(1,'<< /Type /Catalog /Pages 2 0 R >>');object(2,'<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
 object(3,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width/2} ${height/2}] /Resources << /XObject << /I 5 0 R >> >> /Contents 4 0 R >>`);
 const draw=`q ${width/2} 0 0 ${height/2} 0 0 cm /I Do Q`;
 object(4,`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
 offsets[5]=length;append(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);append(jpeg);append('\nendstream\nendobj\n');
 const xref=length;append('xref\n0 6\n0000000000 65535 f \n');for(const offset of offsets.slice(1))append(`${offset.toString().padStart(10,'0')} 00000 n \n`);append(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
 const bytes=new Uint8Array(length);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}return bytes;
}
