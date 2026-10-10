import {describe,it,expect} from 'vitest';
import type {Block} from 'tesseract.js';
import {ocrLayout,recognizeLocalPage} from './ocr-local';
describe('local OCR geometry and closure',()=>{
 const word=(text:string,x:number,y:number,confidence=99)=>({text,confidence,bbox:{x0:x,x1:x+50,y0:y,y1:y+25}});
 const block=(words:unknown[])=>[{paragraphs:[{lines:[{bbox:{x0:0,y0:20,x1:800,y1:50},words}]}]}] as unknown as Block[];
 it('uses the shared OCR line baseline rather than independent glyph heights and preserves column gaps',()=>{
  const out=ocrLayout(block([word('Сумма',400,21),word('операции',460,25),word('Дата',50,22),word('и',110,20),word('время',170,24)]),1000,500,2);
  expect(out.map(i=>i.text)).toEqual(['Дата и время','Сумма операции']);expect(new Set(out.map(i=>i.y)).size).toBe(1);
 });
 it('rejects low-confidence or out-of-bounds glyphs without echoing recognized content',()=>{
  expect(()=>ocrLayout(block([word('Private digits',10,20,60)]),1000,500,2)).toThrow('OCR_UNCERTAIN');
  expect(()=>ocrLayout(block([word('Private digits',1100,20)]),1000,500,2)).toThrow('OCR_UNCERTAIN');
 });
 it('an already closed preparation never starts an OCR worker',async()=>{
  const signal=new AbortController();signal.abort();await expect(recognizeLocalPage({} as HTMLCanvasElement,2,signal.signal)).rejects.toThrow('PREPARATION_CLOSED');
 });
});
