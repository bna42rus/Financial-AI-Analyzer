import {facet,initialSemantics} from '../../../../packages/finance-core/src/model';
import type {Account,Category,Graph,Kind,Operation} from '../../../../packages/finance-core/src/model';
import {calendarDay} from '../../../../packages/finance-core/src/budgets';

export const demoTimezone='Europe/Moscow';
const id=(n:number)=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
export const demoParties={landlord:id(30),proposal:id(31)};
const groups=[
 ['Продукты','Перекрёсток','ВкусВилл','Самокат'],
 ['Кафе и рестораны','Кофейня','Булочная','Городское кафе'],
 ['Транспорт','Метро','Яндекс Go','Московский транспорт'],
 ['Дом и связь','Интернет','Управляющая компания','Мобильная связь'],
 ['Здоровье','Аптека','Спортивный клуб','Медицинский центр'],
 ['Развлечения','Кинотеатр','Яндекс Плюс','Книжный магазин'],
 ['Одежда и покупки','Ozon','Маркет','Магазин одежды'],
] as const;
const accounts:Account[]=[
 {id:id(1),name:'Основная карта',bankId:'tbank',type:'debit_card',analyticsEnabled:true,defaultVisible:true,loanMode:null},
 {id:id(2),name:'Повседневные покупки',bankId:'sber',type:'debit_card',analyticsEnabled:true,defaultVisible:true,loanMode:null},
 {id:id(3),name:'Накопительный счёт',bankId:'ozon',type:'savings',analyticsEnabled:true,defaultVisible:true,loanMode:null},
];
const categories:Category[]=[...groups.map(([name],i)=>({id:id(10+i),name,parentId:null,role:'expense' as const,hidden:false})),
 {id:id(18),name:'Зарплата',parentId:null,role:'income',hidden:false},{id:id(19),name:'Кешбэк',parentId:null,role:'income',hidden:false},
 {id:id(20),name:'Аренда жилья',parentId:null,role:'expense',hidden:false}];

function dayAt(today:string,offset:number){
 const date=new Date(today+'T00:00:00Z');
 date.setUTCDate(date.getUTCDate()-offset);
 return date.toISOString().slice(0,10);
}
export function monthStart(today=calendarDay(new Date(),demoTimezone),offset=0){
 const date=new Date(today.slice(0,7)+'-01T00:00:00Z');
 date.setUTCMonth(date.getUTCMonth()-offset);
 return date.toISOString().slice(0,10);
}
export function demoGraph(now=new Date()):Graph{
 const today=calendarDay(now,demoTimezone);
 const operations:Operation[]=Array.from({length:573},(_,i)=>{
  const group=(i*19+Math.floor(i/11))%groups.length;
  const salary=i%53===9,cashback=i%43===12,transfer=i%37===18,refund=i%47===27;
  const rent=i%113===5,person=i%77===15;
  const kind:Kind=rent||person?'transfer_out':salary?'transfer_in':cashback?'cashback':transfer?'own_transfer':refund?'refund':'purchase';
  const name=rent?'Оплата аренды':person?'Перевод Алексею К.':salary?'Зарплата':cashback?'Кешбэк':transfer?'На накопительный счёт':groups[group]![(Math.floor(i/7)%3)+1]!;
  const amount=rent?-3400000:person?-250000:salary?9150000:cashback?67500:transfer?-750000:refund?25900:-((i*7919)%147000+8700+(group===3?104000:0));
  const semantics=initialSemantics(kind,name,String(amount));
  if(kind==='transfer_in'&&salary)semantics.role=facet('income');
  if(kind==='refund'||rent)semantics.role=facet('expense');
  const needsReview=i%113===102;
  if(!transfer&&!person&&!needsReview)semantics.category=facet(id(rent?20:salary?18:cashback?19:10+group));
  if(rent)semantics.counterparty=facet(demoParties.landlord,'user',true);
  const date=dayAt(today,Math.floor(i*152/573));
  return {id:id(1000+i),...(person?{bankCounterpartyId:demoParties.proposal}:{}),source:{accountId:accounts[transfer?2:i%3===0?1:0]!.id,operationDate:{precision:'day',date},postedDate:null,amountMinor:String(amount),currency:'RUB',sourceKind:kind,merchantText:name,description:transfer?'Перевод между своими счетами':name,bankCategory:'',bankRefHmac:null,versions:{}},corrections:{},semantics,comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:needsReview?['low_category_confidence']:[]};
 });
 return {accounts:structuredClone(accounts),categories:structuredClone(categories),operations,components:[],links:[],loanMode:'cashflow'};
}

export function demoPreview(now=new Date()){
 const graph=demoGraph(now),start=monthStart(calendarDay(now,demoTimezone));
 const amounts=new Map<string,bigint>();
 for(const op of graph.operations){
  const date=op.source.operationDate;
  if(date.precision!=='day'||date.date<start||op.semantics.role.value!=='expense')continue;
  const category=op.semantics.category.value??'';
  amounts.set(category,(amounts.get(category)??0n)-BigInt(op.source.amountMinor));
 }
 const all=[...amounts].sort((a,b)=>Number(b[1]-a[1]));
 const total=all.reduce((sum,[,amount])=>sum+amount,0n);
 const rows=all.slice(0,3).map(([category,amount])=>({name:graph.categories.find(c=>c.id===category)?.name??'Без категории',amount}));
 const rest=all.slice(3).reduce((sum,[,amount])=>sum+amount,0n);
 if(rest>0n)rows.push({name:'Остальные расходы',amount:rest});
 return {total,rows};
}
