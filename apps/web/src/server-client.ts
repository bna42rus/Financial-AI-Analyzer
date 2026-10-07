export type Session = {name:string;scope:'active'|'restricted'|'admin'|'enrollment'|'recovery';capabilities:string[]};
export const apiOrigin=import.meta.env.VITE_API_ORIGIN as string|undefined;
const messages:Record<string,string>={AUTH_REQUIRED:'Войдите в аккаунт.',TOTP_REQUIRED:'Подтвердите вход кодом authenticator.',INVALID_CREDENTIALS:'Проверьте пароль или код.',RATE_LIMITED:'Слишком много попыток. Подождите и повторите.',INVALID_TOKEN:'Ссылка недействительна или истекла.',INVALID_INVITATION:'Приглашение недействительно или уже использовано. Обратитесь в поддержку.',INVALID_REGISTRATION_PROOF:'Подтверждение почты истекло или относится к другому приглашению.',REVIEW_CONFLICT:'Заявка изменилась или решение не соответствует сумме. Обновите данные.',ACTION_CONFLICT:'Это действие уже сохранено с другими параметрами.',INVITATION_UNAVAILABLE:'Приглашение уже использовано, отменено или заменено.',PASSWORD_TOO_SHORT:'Пароль должен содержать от 12 до 128 символов.',INVALID_INPUT:'Проверьте заполненные поля.',EXISTING_ACCOUNT:'Аккаунт уже существует. Используйте вход.',TARIFF_UNAVAILABLE:'Этот тариф сейчас недоступен.'};
export async function api<T>(path:string,body?:Record<string,unknown>):Promise<T> {
  if(!apiOrigin)throw new Error('API не настроен.');
  const origin=new URL(apiOrigin);if(origin.origin!==apiOrigin)throw new Error('Неверный адрес API.');
  let response:Response;
  try{response=await fetch(apiOrigin+path,{method:body?'POST':'GET',credentials:'include',cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});}catch{throw new Error('Не удалось соединиться с сервером. Повторите позже.');}
  const result=await response.json();if(!response.ok)throw new Error(messages[result.code]??'Не удалось выполнить действие. Повторите позже.');return result as T;
}
export function readLink():{kind:string;token:string} {
  const raw=window.location.hash.slice(1),parts=raw.split('?'),query=new URLSearchParams(parts[1]);
  const result={kind:parts[0]??'',token:query.get('token')??''};
  // Secrets stay in memory; remove from address/history before rendering or making requests.
  if(result.token)window.history.replaceState(null,'',window.location.pathname+window.location.search+'#'+result.kind);
  return result;
}
