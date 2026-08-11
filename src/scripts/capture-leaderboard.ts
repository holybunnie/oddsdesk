/**
 * Capture the hackathon leaderboard and persist a snapshot.
 *
 * The page renders client-side and the API is signed at runtime by OKX's own
 * request layer (an EC client signature plus a fingerprint token), so an
 * unauthenticated fetch returns `50113 incorrect request sign parameters`.
 * Rather than reimplement that signing — brittle machinery that would break
 * mid-competition — we let the real page sign its own request and read the
 * response off the wire.
 *
 * The endpoint serves a top-10 window on the full field (63 entrants on day 1)
 * and will not widen: the signature covers the URL, so raising `limit` after the
 * app signs the request is rejected. The window still prices the podium, which
 * is the actionable half of Part VII.
 *
 * Runs as a separate process from the engine on purpose. The engine reads the
 * persisted snapshot and never depends on a browser being healthy — a failed
 * capture must degrade rank steering to "unavailable", never take trading down
 * with it.
 *
 * Every snapshot is kept so the distribution's evolution is reconstructable
 * (Part VII, Robustness).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { parseLeaderboardField, podiumTargets, type LeaderboardSnapshot } from '../rank/steering.js';

const PAGE_URL = 'https://www.okx.ai/hackathon';
const RANK_PATH = '/priapi/v1/wallet/activity/hackathon/rank';
const NAV_TIMEOUT_MS = 90_000;

export interface CaptureResult {
  readonly snapshot: LeaderboardSnapshot;
  readonly path: string;
  readonly fieldSize: number;
}

export async function captureLeaderboard(outputDir: string): Promise<CaptureResult> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 2000 },
    });
    const page = await context.newPage();

    // No URL rewriting: the client signature covers the request URL, so
    // widening `limit` after the app signs it produces 50113 and the response
    // never arrives. The board is a top-10 window and that is what we take.
    const bodyPromise = page
      .waitForResponse((response) => response.url().includes(RANK_PATH) && response.status() === 200, {
        timeout: NAV_TIMEOUT_MS,
      })
      .then(async (response) => response.text());

    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    const raw = await bodyPromise;

    // Parse before persisting: a snapshot that cannot be parsed is not a
    // snapshot, and writing it would let a stale-but-valid one be replaced by
    // a broken one.
    const { rows, fieldSize } = parseLeaderboardField(raw);
    const snapshot: LeaderboardSnapshot = { capturedAtMs: Date.now(), rows, rawHtml: raw };

    const latest = join(outputDir, 'latest.json');
    mkdirSync(dirname(latest), { recursive: true });
    const serialised = JSON.stringify(snapshot, null, 2);
    writeFileSync(join(outputDir, `${snapshot.capturedAtMs}.json`), serialised);
    writeFileSync(latest, serialised);
    return { snapshot, path: latest, fieldSize };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const outputDir = process.argv[2] ?? 'var/leaderboard';
  const { snapshot, path, fieldSize } = await captureLeaderboard(outputDir);
  const byPct = [...snapshot.rows].sort((a, b) => b.pnlPct - a.pnlPct);
  const byAbs = [...snapshot.rows].sort((a, b) => b.pnlAbs - a.pnlAbs);
  const negatives = snapshot.rows.filter((r) => r.pnlAbs < 0).length;

  const targets = podiumTargets(snapshot.rows);
  console.log(`captured ${snapshot.rows.length} of ${fieldSize} entrants -> ${path}`);
  console.log(
    `podium costs: rank3 ${(100 * targets.pctAtRank3).toFixed(2)}% / ${targets.absAtRank3.toFixed(2)} USDT  |  ` +
      `rank1 ${(100 * targets.pctAtRank1).toFixed(2)}% / ${targets.absAtRank1.toFixed(2)} USDT`,
  );
  console.log(`visible window is all winners by construction; attrition across the other ${fieldSize - snapshot.rows.length} entrants is not observable (${negatives} negative here)\n`);
  console.log('rank  by PnL%                          by PnL absolute');
  for (let index = 0; index < Math.min(10, snapshot.rows.length); index += 1) {
    const pct = byPct[index]!;
    const abs = byAbs[index]!;
    console.log(
      `${String(index + 1).padStart(3)}   ${pct.entrant.slice(0, 22).padEnd(24)}${(100 * pct.pnlPct).toFixed(2).padStart(8)}%   ` +
        `${abs.entrant.slice(0, 22).padEnd(24)}${abs.pnlAbs.toFixed(2).padStart(10)}`,
    );
  }
}

if (process.argv[1]?.endsWith('capture-leaderboard.ts')) {
  void main();
}
