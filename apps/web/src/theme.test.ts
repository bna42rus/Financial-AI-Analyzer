import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
const source=readFileSync(new URL('./theme.css',import.meta.url),'utf8');
const token=(name:string)=>{const m=new RegExp('--color-'+name+':\\s*light-dark\\((#[a-f0-9]{3,8}),\\s*(#[a-f0-9]{3,8})\\)','i').exec(source);if(!m)throw Error('Missing theme color '+name);return [m[1]!,m[2]!] as const;};
function luminance(hex:string){let h=hex.slice(1);if(h.length===3)h=[...h].map(c=>c+c).join('');const rgb=[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);return .2126*rgb[0]!+.7152*rgb[1]!+.0722*rgb[2]!;}
function contrast(a:string,b:string){const [hi,lo]=[luminance(a),luminance(b)].sort((x,y)=>y-x);return (hi!+.05)/(lo!+.05);}
describe('CashNeuro light and dark contrast',()=>{for(const theme of [0,1])it('keeps text, actions and warning text readable in '+(theme?'dark':'light')+' theme',()=>{for(const [fg,bg]of [['text','background'],['text','surface'],['secondary-text','background'],['secondary-text','surface'],['primary-text','primary'],['warning','warning-surface'],['primary','soft']])expect(contrast(token(fg!)[theme]!,token(bg!)[theme]!)).toBeGreaterThanOrEqual(4.5);});});
