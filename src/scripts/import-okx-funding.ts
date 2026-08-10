/**
 * Replace an input replay dataset's funding history with an exact OKX
 * historical funding-rate CSV export.
 *
 * The public API's short history is not silently extended or substituted with
 * Binance funding.  This importer accepts the official OKX download and keeps
 * the venue identity in the dataset metadata.
 *
 * Usage:
 *   npm run import-okx-funding -- \
 *     var/backtest/majors-540d-multivenue.json \
 *     --csv var/data/okx-funding.csv \
 *     --out var/backtest/majors-540d-exact.json
 *
 * If the CSV is one instrument per file and has no instrument column, add
 * `--default-symbol BTC` (repeat the import per file or combine files first).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadReplayDataset } from '../backtest/replay.js';
import type { FundingPoint } from '../market/okx.js';
import { baseSymbol } from '../signal/scanner.js';

function valueAfter(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function normalise(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/gu, '');
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      fields.push(field.trim());
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('CSV has an unterminated quoted field');
  fields.push(field.trim());
  return fields;
}

function headerIndex(headers: readonly string[], candidates: readonly string[], required: boolean): number | undefined {
  for (const candidate of candidates) {
    const index = headers.indexOf(candidate);
    if (index >= 0) return index;
  }
  if (required) throw new Error(`CSV is missing a required column: ${candidates.join(' or ')}`);
  return undefined;
}

function parseTimestamp(raw: string): number {
  const numeric = Number(raw.trim());
  if (Number.isFinite(numeric)) {
    const milliseconds = Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric;
    if (milliseconds > 0) return milliseconds;
  }
  const parsed = Date.parse(raw.trim());
  if (!Number.isFinite(parsed)) throw new Error(`invalid funding timestamp ${raw}`);
  return parsed;
}

function parseRate(raw: string): number {
  const trimmed = raw.trim();
  const percent = trimmed.endsWith('%');
  const numeric = Number(percent ? trimmed.slice(0, -1) : trimmed);
  if (!Number.isFinite(numeric)) throw new Error(`invalid funding rate ${raw}`);
  const rate = percent ? numeric / 100 : numeric;
  if (!Number.isFinite(rate)) throw new Error(`funding rate is not finite ${raw}`);
  return rate;
}

function aliases(instId: string): ReadonlySet<string> {
  const base = baseSymbol(instId);
  return new Set([
    normalise(instId),
    normalise(base),
    normalise(`${base}USDT`),
    normalise(`${base}USDT-SWAP`),
    normalise(`${base}USD-SWAP`),
    normalise(`${base}USD_PERP`),
    normalise(`${base}USDT_PERP`),
  ]);
}

interface ImportRow {
  readonly instrument: string | undefined;
  readonly point: FundingPoint;
}

function parseRows(csv: string, defaultSymbol: string | undefined): ImportRow[] {
  const lines = csv.replace(/^\uFEFF/u, '').split(/\r?\n/u).filter((line) => line.trim() !== '');
  if (lines.length < 2) throw new Error('funding CSV must contain a header and at least one data row');
  const headers = parseCsvLine(lines[0]!).map(normalise);
  const instrumentColumn = headerIndex(headers, ['INSTID', 'INSTRUMENTID', 'INSTRUMENT', 'SYMBOL', 'CONTRACT'], false);
  const timestampColumn = headerIndex(headers, ['FUNDINGTIME', 'FUNDINGTIMESTAMP', 'TIMESTAMP', 'TIME'], true);
  const rateColumn = headerIndex(headers, ['FUNDINGRATE', 'REALIZEDRATE', 'REALISEDRATE', 'RATE'], true);
  const rows: ImportRow[] = [];
  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line);
    const timestamp = parseTimestamp(fields[timestampColumn!] ?? '');
    const fundingRate = parseRate(fields[rateColumn!] ?? '');
    const instrument = instrumentColumn === undefined ? defaultSymbol : fields[instrumentColumn];
    if (instrument !== undefined && instrument.trim() === '') throw new Error(`funding row has an empty instrument at ${timestamp}`);
    rows.push({ instrument: instrument?.trim(), point: { timestampMs: timestamp, fundingRate } });
  }
  return rows;
}

function resolveInstrument(raw: string | undefined, instruments: readonly { instId: string }[]): string {
  if (raw === undefined) throw new Error('CSV has no instrument column; supply --default-symbol');
  const token = normalise(raw);
  const match = instruments.find((instrument) => aliases(instrument.instId).has(token));
  if (match === undefined) throw new Error(`funding CSV instrument ${raw} is not in the replay dataset`);
  return match.instId;
}

function deduplicate(points: readonly FundingPoint[], instId: string): readonly FundingPoint[] {
  const byTime = new Map<number, number>();
  for (const point of points) {
    const prior = byTime.get(point.timestampMs);
    if (prior !== undefined && Math.abs(prior - point.fundingRate) > 1e-12) {
      throw new Error(`conflicting funding rates for ${instId} at ${point.timestampMs}`);
    }
    byTime.set(point.timestampMs, point.fundingRate);
  }
  return [...byTime.entries()]
    .sort(([left], [right]) => left - right)
    .map(([timestampMs, fundingRate]) => ({ timestampMs, fundingRate }));
}

async function main(): Promise<void> {
  const input = process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.json'));
  if (input === undefined) throw new Error('provide a replay dataset JSON path');
  const csvPath = valueAfter('--csv', '');
  if (csvPath === '') throw new Error('--csv is required');
  const output = valueAfter('--out', input.replace(/\.json$/u, '-exact-funding.json'));
  const defaultSymbol = valueAfter('--default-symbol', '').trim().toUpperCase() || undefined;
  const dataset = loadReplayDataset(input);
  const rows = parseRows(readFileSync(resolve(csvPath), 'utf8'), defaultSymbol);
  const grouped = new Map<string, FundingPoint[]>();
  for (const row of rows) {
    const instId = resolveInstrument(row.instrument, dataset.instruments);
    const bucket = grouped.get(instId) ?? [];
    bucket.push(row.point);
    grouped.set(instId, bucket);
  }
  if (grouped.size === 0) throw new Error('funding CSV contained no usable rows');

  const instruments = dataset.instruments.map((instrument) => {
    const imported = grouped.get(instrument.instId);
    return imported === undefined ? instrument : { ...instrument, funding: deduplicate(imported, instrument.instId) };
  });
  const rawRoot = JSON.parse(readFileSync(resolve(input), 'utf8')) as Record<string, unknown>;
  const dataSources = typeof rawRoot.dataSources === 'object' && rawRoot.dataSources !== null
    ? rawRoot.dataSources as Record<string, unknown>
    : {};
  const result = {
    ...rawRoot,
    importedAtMs: Date.now(),
    dataSources: {
      ...dataSources,
      funding: 'Exact OKX historical funding-rate CSV import; Binance funding is not used',
    },
    instruments,
  };
  const absolute = resolve(output);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, JSON.stringify(result), 'utf8');
  console.log(`imported ${rows.length} rows across ${grouped.size}/${dataset.instruments.length} instruments`);
  for (const instrument of dataset.instruments) {
    const points = grouped.get(instrument.instId);
    if (points !== undefined) {
      const exact = deduplicate(points, instrument.instId);
      console.log(`  ${instrument.instId.padEnd(24)} funding=${exact.length} ${new Date(exact[0]!.timestampMs).toISOString()} → ${new Date(exact.at(-1)!.timestampMs).toISOString()}`);
    } else {
      console.log(`  ${instrument.instId.padEnd(24)} funding=unchanged (no imported rows)`);
    }
  }
  console.log(`wrote exact-funding dataset to ${absolute}`);
}

main().catch((error: unknown) => {
  console.error('OKX FUNDING IMPORT FAILED:', error);
  process.exitCode = 1;
});

