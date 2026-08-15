import { describe, expect, it } from 'vitest';
import { drawLayer, placeLayer, type Canvas2D, type Placeable } from '../src/compose.js';

const FULL = { left: 0, top: 0, right: 1, bottom: 1 };
const IDENTITY = { scale: 1, x: 0, y: 0, rotation: 0 };

function layer(over: Partial<Placeable> = {}): Placeable {
  return { transform: IDENTITY, crop: FULL, opacity: 1, ...over };
}

const PORTRAIT = { width: 1080, height: 1920 };
const LANDSCAPE = { width: 1920, height: 1080 };

describe('placeLayer', () => {
  it('fills the frame exactly when the aspect ratios match', () => {
    const at = placeLayer(layer(), PORTRAIT, { width: 540, height: 960 });
    expect(at.dw).toBe(540);
    expect(at.dh).toBe(960);
    expect(at.cx).toBe(270);
    expect(at.cy).toBe(480);
  });

  it('covers rather than fits, so scale 1 never letterboxes', () => {
    // Portrait footage in a landscape frame: the height overflows and is cropped, and the
    // width is exactly filled. A "fit" convention would give dh === 1080 and black bars.
    const at = placeLayer(layer(), PORTRAIT, LANDSCAPE);
    expect(at.dw).toBe(1920);
    expect(at.dh).toBeCloseTo(3413.33, 1);
    expect(at.dh).toBeGreaterThan(LANDSCAPE.height);
  });

  it('treats scale as a plain zoom on top of the cover fit', () => {
    const plain = placeLayer(layer(), PORTRAIT, PORTRAIT);
    const zoomed = placeLayer(layer({ transform: { ...IDENTITY, scale: 1.5 } }), PORTRAIT, PORTRAIT);
    expect(zoomed.dw / plain.dw).toBeCloseTo(1.5, 6);
    expect(zoomed.dh / plain.dh).toBeCloseTo(1.5, 6);
    // A zoom stays centred; only a pan moves it.
    expect(zoomed.cx).toBe(plain.cx);
  });

  it('pans by a fraction of the output frame, not of the source', () => {
    const out = { width: 720, height: 1280 };
    const at = placeLayer(layer({ transform: { ...IDENTITY, x: 0.25, y: -0.1 } }), PORTRAIT, out);
    expect(at.cx).toBe(720 / 2 + 180);
    expect(at.cy).toBe(1280 / 2 - 128);
  });

  it('reads only the cropped region of the source', () => {
    const at = placeLayer(
      layer({ crop: { left: 0.25, top: 0.1, right: 0.75, bottom: 0.9 } }),
      PORTRAIT,
      PORTRAIT,
    );
    expect(at.sx).toBe(270);
    expect(at.sy).toBe(192);
    expect(at.sw).toBe(540);
    expect(at.sh).toBe(1536);
  });

  it('re-covers after a crop, so cropping does not shrink the picture', () => {
    // Cropping to the middle half and then drawing it means the visible part has to be
    // scaled up to fill the frame again — otherwise a crop would read as a zoom out.
    const at = placeLayer(
      layer({ crop: { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 } }),
      PORTRAIT,
      PORTRAIT,
    );
    expect(at.dw).toBeGreaterThanOrEqual(PORTRAIT.width);
    expect(at.dh).toBeGreaterThanOrEqual(PORTRAIT.height);
  });

  it('converts rotation to radians', () => {
    expect(placeLayer(layer({ transform: { ...IDENTITY, rotation: 90 } }), PORTRAIT, PORTRAIT).rotation)
      .toBeCloseTo(Math.PI / 2, 9);
  });
});

/** Records what a real context would have been asked to do. */
function recorder() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '' as unknown,
    save: () => calls.push({ op: 'save', args: [] }),
    restore: () => calls.push({ op: 'restore', args: [] }),
    translate: (...args: unknown[]) => calls.push({ op: 'translate', args }),
    rotate: (...args: unknown[]) => calls.push({ op: 'rotate', args }),
    fillRect: (...args: unknown[]) => calls.push({ op: 'fillRect', args }),
    drawImage: (...args: unknown[]) => calls.push({ op: 'drawImage', args }),
  } as unknown as Canvas2D;
  return { ctx, calls };
}

const IMAGE = {} as CanvasImageSource;

describe('drawLayer', () => {
  it('draws the placement around the centre and restores the context', () => {
    const { ctx, calls } = recorder();
    drawLayer(ctx, IMAGE, PORTRAIT, layer(), { width: 540, height: 960 });

    expect(calls.map((call) => call.op)).toEqual(['save', 'translate', 'drawImage', 'restore']);
    expect(calls[1]!.args).toEqual([270, 480]);
    expect(calls[2]!.args).toEqual([IMAGE, 0, 0, 1080, 1920, -270, -480, 540, 960]);
  });

  it('skips a fully transparent layer instead of drawing it', () => {
    const { ctx, calls } = recorder();
    drawLayer(ctx, IMAGE, PORTRAIT, layer({ opacity: 0 }), PORTRAIT);
    expect(calls).toEqual([]);
  });

  it('only rotates when there is a rotation', () => {
    const { ctx, calls } = recorder();
    drawLayer(ctx, IMAGE, PORTRAIT, layer({ transform: { ...IDENTITY, rotation: 5 } }), PORTRAIT);
    expect(calls.map((call) => call.op)).toContain('rotate');
  });
});
