import type { Timeline } from './schema/timeline.js';

/**
 * Stable digest of a timeline.
 *
 * Used by the log to record what the timeline looked like after each event, so a replay
 * that diverges from the recorded session is detectable instead of silently producing a
 * different training example.
 *
 * Deliberately synchronous and dependency-free: it runs on every logged edit on a phone,
 * where an async WebCrypto round-trip per keystroke is not free. FNV-1a over canonical
 * JSON is not collision-resistant against an adversary, and does not need to be — the
 * only thing it defends against is accidental drift.
 */
export function digestTimeline(timeline: Timeline): string {
  return fnv1a64(canonicalJson(timeline));
}

export function digest(value: unknown): string {
  return fnv1a64(canonicalJson(value));
}

/**
 * JSON with object keys sorted, so two structurally equal timelines always serialize
 * identically regardless of how their objects were built up.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** 64-bit FNV-1a, run as two 32-bit lanes so it stays exact in JS numbers. */
function fnv1a64(input: string): string {
  let high = 0x811c9dc5;
  let low = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    high ^= code;
    high = Math.imul(high, 0x01000193) >>> 0;
    low ^= code + i;
    low = Math.imul(low, 0x01000193) >>> 0;
  }

  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}
