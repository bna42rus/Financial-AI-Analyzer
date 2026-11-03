/** Change only presentation; preserve the stored placeholder and search text. */
export const maskedOperationText=(text:string)=>text.replace(/\[(?:реквизиты скрыты|скрыто)\]|\((?:реквизиты скрыты|скрыто)\)/giu,'*****');
