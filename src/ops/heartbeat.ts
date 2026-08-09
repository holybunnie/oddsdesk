import { mkdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface HeartbeatRecord {
  readonly writtenAtMs: number;
  readonly pid: number;
}

export class HeartbeatError extends Error {
  override readonly name = 'HeartbeatError';
}

/** Write a complete heartbeat record atomically so a reader never sees JSON mid-write. */
export function writeHeartbeat(path: string, writtenAtMs = Date.now(), pid = process.pid): void {
  if (!Number.isFinite(writtenAtMs) || writtenAtMs <= 0) {
    throw new HeartbeatError(`heartbeat timestamp must be positive and finite, got ${writtenAtMs}`);
  }
  if (!Number.isInteger(pid) || pid <= 0) throw new HeartbeatError(`heartbeat pid must be positive, got ${pid}`);

  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ writtenAtMs, pid } satisfies HeartbeatRecord)}\n`, 'utf8');
  renameSync(temporary, absolute);
}

/** Read and validate the last heartbeat. Missing or malformed means unhealthy. */
export function readHeartbeat(path: string): HeartbeatRecord {
  const absolute = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (cause) {
    throw new HeartbeatError(`cannot read heartbeat at ${absolute}`, { cause });
  }

  const row = parsed as Record<string, unknown>;
  if (
    typeof row.writtenAtMs !== 'number' || !Number.isFinite(row.writtenAtMs) || row.writtenAtMs <= 0 ||
    typeof row.pid !== 'number' || !Number.isInteger(row.pid) || row.pid <= 0
  ) {
    throw new HeartbeatError(`heartbeat at ${absolute} is malformed`);
  }
  return { writtenAtMs: row.writtenAtMs, pid: row.pid };
}
