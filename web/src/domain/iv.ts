export type IvProvenance = 'pool' | 'trailing-realised';

export type IvDisplay =
  | {
      readonly kind: 'show';
      readonly sigma: string;
      readonly provenance: IvProvenance;
      readonly ageSessions: string;
    }
  | { readonly kind: 'omit'; readonly message: string };

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

export function formatPublishedIv(input: {
  readonly sigmaWad: bigint;
  readonly provenance: IvProvenance;
  readonly ageSessions: bigint;
}): IvDisplay {
  return {
    kind: 'show',
    sigma: formatWad(input.sigmaWad),
    provenance: input.provenance,
    ageSessions: input.ageSessions.toString(),
  };
}

export function formatOmittedIv(message?: string): IvDisplay {
  return {
    kind: 'omit',
    message: message ?? 'Implied volatility is not published.',
  };
}
