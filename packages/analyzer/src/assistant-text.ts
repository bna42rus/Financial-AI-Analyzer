import { sanitizeText } from '../../privacy/src/text.ts';

/** Display text may have paragraphs. Apply the existing privacy guard across
 * the WHOLE text first, so line breaks cannot hide a split identifier. */
export function assistantDisplayText(value: unknown, max = 8000): string {
  if (typeof value !== 'string' || value.length > max) throw new TypeError('UNSANITIZED_TEXT');
  const normalized = value.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim();
  const guarded = sanitizeText(normalized);
  if (!guarded || guarded.length > max || normalized.length > max) throw new TypeError('UNSANITIZED_TEXT');
  return guarded === normalized.replace(/\n/g, ' ').trim() ? normalized : guarded;
}

// Without sources/calculator, a qualitative answer must not present invented
// rates, dated statistics, returns or numerical arithmetic as checked facts.
export const explanationNeedsReview = (text: string) => /\p{N}|https?:\/\/|www\./u.test(text);
