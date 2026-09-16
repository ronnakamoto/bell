export type Quote =
  | { readonly verdict: 'Usable'; readonly lambdaWad: bigint; readonly premiumWad: bigint }
  | { readonly verdict: 'Fallback'; readonly lambdaWad: bigint; readonly premiumWad: bigint }
  | { readonly verdict: 'Refuse' };

export type QuoteDisplay =
  | {
      readonly kind: 'price';
      readonly verdict: 'Usable' | 'Fallback';
      readonly lambda: string;
      readonly premium: string;
      readonly isFallback: boolean;
    }
  | { readonly kind: 'refuse'; readonly verdict: 'Refuse'; readonly message: string };

const WAD = 10n ** 18n;

function formatWad(wad: bigint): string {
  const negative = wad < 0n;
  const magnitude = negative ? -wad : wad;
  const whole = magnitude / WAD;
  const fraction = magnitude % WAD;
  if (fraction === 0n) return `${negative ? '-' : ''}${String(whole)}`;
  const padded = fraction.toString().padStart(18, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${String(whole)}.${padded}`;
}

export function formatQuote(quote: Quote): QuoteDisplay {
  switch (quote.verdict) {
    case 'Usable':
      return {
        kind: 'price',
        verdict: 'Usable',
        lambda: formatWad(quote.lambdaWad),
        premium: formatWad(quote.premiumWad),
        isFallback: false,
      };
    case 'Fallback':
      return {
        kind: 'price',
        verdict: 'Fallback',
        lambda: formatWad(quote.lambdaWad),
        premium: formatWad(quote.premiumWad),
        isFallback: true,
      };
    case 'Refuse':
      return {
        kind: 'refuse',
        verdict: 'Refuse',
        message: 'Do not price — quote refused.',
      };
  }
}
