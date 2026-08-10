import { describe, expect, it } from 'vitest';
import { classifyBreadthChange } from './relative-pullback.js';

describe('directional breadth change', () => {
  it('classifies expansion, contraction, and flat breadth without thresholds', () => {
    expect(classifyBreadthChange(4, 3)).toBe('expanding');
    expect(classifyBreadthChange(3, 4)).toBe('contracting');
    expect(classifyBreadthChange(3, 3)).toBe('flat');
  });

  it('rejects malformed breadth counts', () => {
    expect(() => classifyBreadthChange(-1, 2)).toThrow(/non-negative integers/);
    expect(() => classifyBreadthChange(2.5, 2)).toThrow(/non-negative integers/);
  });
});
