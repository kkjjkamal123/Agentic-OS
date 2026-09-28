import { describe, expect, it } from 'vitest';
import { clampRect, focusedWindow, MIN_H, MIN_W, type WinState } from '../../src/renderer/shell/windows';

describe('clampRect', () => {
  const bounds = { w: 1200, h: 700 };
  it('enforces minimum size and keeps the title bar reachable', () => {
    const r = clampRect({ x: -5000, y: -40, w: 10, h: 10 }, bounds);
    expect(r.w).toBe(MIN_W);
    expect(r.h).toBe(MIN_H);
    expect(r.y).toBe(0);
    expect(r.x + r.w).toBeGreaterThanOrEqual(80);
    const far = clampRect({ x: 5000, y: 5000, w: 400, h: 300 }, bounds);
    expect(far.x).toBe(bounds.w - 80);
    expect(far.y).toBe(bounds.h - 44);
  });
  it('never exceeds the desktop', () => {
    expect(clampRect({ x: 0, y: 0, w: 9999, h: 9999 }, bounds)).toMatchObject({ w: 1200, h: 700 });
  });
});

describe('focusedWindow', () => {
  const w = (id: WinState['id'], z: number, minimized = false): WinState => ({ id, z, minimized, maximized: false, x: 0, y: 0, w: 400, h: 300 });
  it('is the highest visible window', () => {
    expect(focusedWindow([w('mission', 1), w('settings', 3, true), w('agents', 2)])?.id).toBe('agents');
    expect(focusedWindow([w('mission', 1, true)])).toBeUndefined();
  });
});
