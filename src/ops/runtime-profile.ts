import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { VenueProfile } from '../execution/adapter.js';

export interface RuntimeFacts {
  readonly stopCustody: VenueProfile['stopCustody'];
  readonly positionMode: 'long_short_mode' | 'net_mode';
}

/** Read only measured runtime facts; never invent a stop or position mode. */
export function readRuntimeProfile(path = 'config/runtime-profile.tradekit.yaml'): RuntimeFacts {
  let raw: string;
  try {
    raw = readFileSync(resolve(path), 'utf8');
  } catch {
    throw new Error(
      `no runtime profile at ${path}. Stop custody and position mode are unknown until ` +
        'the venue has been measured. Refusing to guess either.',
    );
  }

  const parsed = parseYaml(raw) as {
    stops?: { custody?: unknown; killTestObserved?: unknown };
    account?: { positionMode?: unknown };
  };
  const custody = parsed?.stops?.custody;
  if (custody !== 'venue-held' && custody !== 'client-held' && custody !== 'none' && custody !== 'unverified') {
    throw new Error(
      `runtime profile has stops.custody ${JSON.stringify(custody)}; expected one of ` +
        'venue-held | client-held | none | unverified.',
    );
  }
  if (custody !== 'unverified' && parsed.stops?.killTestObserved !== true) {
    throw new Error(
      `runtime profile claims stops.custody "${custody}" but killTestObserved is not true. ` +
        'A custody value that was not observed is worse than none — it puts an unverified stop ' +
        'mechanism in front of a leveraged book while looking verified.',
    );
  }

  const positionMode = parsed?.account?.positionMode;
  if (positionMode !== 'long_short_mode' && positionMode !== 'net_mode') {
    throw new Error(
      `runtime profile has account.positionMode ${JSON.stringify(positionMode)}; expected ` +
        'long_short_mode | net_mode. Getting this wrong makes every order carry the wrong posSide.',
    );
  }
  return { stopCustody: custody, positionMode };
}
