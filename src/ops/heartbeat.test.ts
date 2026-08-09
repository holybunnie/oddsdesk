import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readHeartbeat, writeHeartbeat } from './heartbeat.js';

describe('heartbeat', () => {
  it('writes and reads an atomic record', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'heartbeat-')), 'engine.json');
    writeHeartbeat(path, 1_000, 42);
    expect(readHeartbeat(path)).toEqual({ writtenAtMs: 1_000, pid: 42 });
  });
});
