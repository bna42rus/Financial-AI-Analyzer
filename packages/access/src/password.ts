export const passwordMinimum=8;
export const passwordMaximum=128;
export const passwordRule='Не менее 8 символов, включая хотя бы одну букву и одну цифру.';

export function validNewPassword(value:unknown):value is string {
 return typeof value==='string'&&[...value].length>=passwordMinimum&&value.length<=passwordMaximum&&/\p{L}/u.test(value)&&/\p{Nd}/u.test(value);
}
