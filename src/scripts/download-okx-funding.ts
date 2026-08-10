/**
 * Download exact OKX historical funding files and attach them to a replay
 * dataset.  OKX's bulk catalog limits each request to ten days; this script
 * uses nine-day windows and de-duplicates the daily archives at the row level.
 *
 * Usage:
 *   npm run download-okx-funding -- \
 *     var/backtest/majors-540d-multivenue.json \
 *     --out var/backtest/majors-540d-exact.json
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadReplayDataset } from '../backtest/replay.js';
import type { FundingPoint } from '../market/okx.js';

const DAY_MS = 86_400_000;
const NINE_DAYS_MS = 9 * DAY_MS;
const CATALOG = 'https://www.okx.com/api/v5/public/market-data-history';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function valueAfter(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

interface CatalogFile {
  readonly filename: string;
  readonly url: string;
}

function numberField(value: string, field: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${field} is not finite: ${value}`);
  return result;
}

async function catalogFiles(begin: number, end: number): Promise<readonly CatalogFile[]> {
  const url = new URL(CATALOG);
  url.searchParams.set('module', '3');
  url.searchParams.set('instType', 'SWAP');
  // OKX returns the all-swap funding archive for this public module.  The
  // downloader filters its rows to the six OKX instruments in our dataset.
  url.searchParams.set('instIdList', 'BTC-USDT-SWAP');
  url.searchParams.set('dateAggrType', 'daily');
  url.searchParams.set('begin', String(begin));
  url.searchParams.set('end', String(end));
  let response: Response | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    response = await fetch(url);
    if (response.ok) break;
    if (response.status !== 429 && response.status < 500) throw new Error(`OKX catalog returned HTTP ${response.status}`);
    await sleep(500 * 2 ** attempt);
  }
  if (response === undefined || !response.ok) throw new Error(`OKX catalog returned HTTP ${response?.status ?? 'unknown'}`);
  const body = await response.json() as { code?: string; msg?: string; data?: Array<{ details?: Array<{ groupDetails?: Array<{ filename?: string; url?: string }> }> }> };
  if (body.code !== '0') throw new Error(`OKX funding catalog ${body.code}: ${body.msg ?? ''}`);
  const details = body.data?.[0]?.details ?? [];
  const files: CatalogFile[] = [];
  for (const detail of details) {
    for (const group of detail.groupDetails ?? []) {
      if (typeof group.filename !== 'string' || typeof group.url !== 'string') throw new Error('OKX catalog returned an incomplete funding file entry');
      files.push({ filename: group.filename, url: group.url });
    }
  }
  return files;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`OKX funding archive returned HTTP ${response.status}`);
  const temporary = mkdtempSync(join(tmpdir(), 'oddsdesk-okx-funding-'));
  const archive = join(temporary, 'funding.zip');
  try {
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.endsWith('.csv'));
    const entry = entries[0];
    if (entry === undefined) throw new Error(`OKX archive ${url} contains no CSV`);
    return execFileSync('unzip', ['-p', archive, entry], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function parseFundingCsv(csv: string, instruments: ReadonlySet<string>, fromMs: number, toMs: number): Map<string, FundingPoint[]> {
  const lines = csv.replace(/^\uFEFF/u, '').split(/\r?\n/u).filter((line) => line.trim() !== '');
  if (lines.length < 2) throw new Error('OKX funding archive contains no data rows');
  const headers = lines[0]!.split(',').map((value) => value.trim().toLowerCase());
  const instrumentIndex = headers.indexOf('instrument_name');
  const rateIndex = headers.indexOf('funding_rate');
  const timeIndex = headers.indexOf('funding_time');
  if (instrumentIndex < 0 || rateIndex < 0 || timeIndex < 0) throw new Error(`unexpected OKX funding columns: ${headers.join(',')}`);
  const result = new Map<string, FundingPoint[]>();
  for (const line of lines.slice(1)) {
    const fields = line.split(',');
    const instId = fields[instrumentIndex]?.trim();
    if (instId === undefined || !instruments.has(instId)) continue;
    const timestampMs = numberField(fields[timeIndex] ?? '', 'funding_time');
    if (timestampMs < fromMs || timestampMs > toMs) continue;
    const fundingRate = numberField(fields[rateIndex] ?? '', 'funding_rate');
    const bucket = result.get(instId) ?? [];
    bucket.push({ timestampMs, fundingRate });
    result.set(instId, bucket);
  }
  return result;
}

function deduplicate(points: readonly FundingPoint[]): readonly FundingPoint[] {
  const byTime = new Map<number, number>();
  for (const point of points) byTime.set(point.timestampMs, point.fundingRate);
  return [...byTime.entries()]
    .sort(([left], [right]) => left - right)
    .map(([timestampMs, fundingRate]) => ({ timestampMs, fundingRate }));
}

async function main(): Promise<void> {
  const input = process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.json'));
  if (input === undefined) throw new Error('provide a replay dataset JSON path');
  const output = valueAfter('--out', input.replace(/\.json$/u, '-exact.json'));
  const dataset = loadReplayDataset(input);
  const fromMs = (dataset.replayFromMs ?? 0) - 2 * DAY_MS;
  const toMs = (dataset.replayToMs ?? Date.now()) + 2 * DAY_MS;
  const instrumentIds = new Set(dataset.instruments.map((instrument) => instrument.instId));
  const windows: Array<{ begin: number; end: number }> = [];
  for (let begin = Math.floor(fromMs / DAY_MS) * DAY_MS; begin < toMs; begin += NINE_DAYS_MS) {
    windows.push({ begin, end: Math.min(begin + NINE_DAYS_MS - 1, toMs) });
  }
  const files = new Map<string, CatalogFile>();
  const catalogBatchSize = 2;
  for (let start = 0; start < windows.length; start += catalogBatchSize) {
    const batch = windows.slice(start, start + catalogBatchSize);
    const chunks = await Promise.all(batch.map((window) => catalogFiles(window.begin, window.end)));
    for (let index = 0; index < batch.length; index += 1) {
      const window = batch[index]!;
      const chunk = chunks[index]!;
      for (const file of chunk) files.set(file.filename, file);
      console.log(`catalog ${new Date(window.begin).toISOString()} → ${new Date(window.end).toISOString()} files=${chunk.length}`);
    }
  }
  if (files.size === 0) throw new Error('OKX returned no funding archives for the replay range');

  const grouped = new Map<string, FundingPoint[]>();
  const fileList = [...files.values()];
  const batchSize = 8;
  for (let start = 0; start < fileList.length; start += batchSize) {
    const batch = fileList.slice(start, start + batchSize);
    const csvs = await Promise.all(batch.map(async (file) => ({ file, csv: await fetchText(file.url) })));
    for (const item of csvs) {
      const rows = parseFundingCsv(item.csv, instrumentIds, fromMs, toMs);
      for (const [instId, points] of rows) grouped.set(instId, [...(grouped.get(instId) ?? []), ...points]);
    }
    console.log(`downloaded ${Math.min(start + batchSize, fileList.length)}/${fileList.length} exact funding archives`);
  }
  const missing = dataset.instruments.map((instrument) => instrument.instId).filter((instId) => !grouped.has(instId));
  if (missing.length > 0) throw new Error(`OKX exact funding is missing instruments: ${missing.join(', ')}`);

  const instruments = dataset.instruments.map((instrument) => ({
    ...instrument,
    funding: deduplicate(grouped.get(instrument.instId) ?? []),
  }));
  const rawRoot = JSON.parse(readFileSync(resolve(input), 'utf8')) as Record<string, unknown>;
  const dataSources = typeof rawRoot.dataSources === 'object' && rawRoot.dataSources !== null
    ? rawRoot.dataSources as Record<string, unknown>
    : {};
  const result = {
    ...rawRoot,
    importedAtMs: Date.now(),
    dataSources: {
      ...dataSources,
      funding: 'Exact OKX bulk historical market-data module 3; daily all-swap funding archives',
    },
    instruments,
  };
  const absolute = resolve(output);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, JSON.stringify(result), 'utf8');
  const validated = loadReplayDataset(absolute);
  console.log(`wrote exact OKX funding dataset to ${absolute}`);
  for (const instrument of validated.instruments) {
    const points = instrument.funding ?? [];
    console.log(`  ${instrument.instId.padEnd(24)} funding=${points.length} ${new Date(points[0]!.timestampMs).toISOString()} → ${new Date(points.at(-1)!.timestampMs).toISOString()}`);
  }
}

main().catch((error: unknown) => {
  console.error('OKX FUNDING DOWNLOAD FAILED:', error);
  process.exitCode = 1;
});
