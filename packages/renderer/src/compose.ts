import type { ColorValue, CropRect, TransformValue } from '@evocut/edl';
import { filterFor } from './color.js';

/**
 * Where a decoded frame lands inside the output frame.
 *
 * The geometry is separated from the drawing so it can be tested without a canvas, and so
 * the preview and the export can share it exactly. "The zoom looks different in the export"
 * is the same class of bug as "the cut is in the wrong place in the export", and it has the
 * same cure: one implementation, used by both.
 *
 * ## The convention
 *
 * `scale: 1` means **cover**: the source fills the output frame, cropping whichever axis
 * is longer. That is what makes `scale` a plain zoom factor the model can reason about —
 * 1.15 is a gentle push-in at any resolution, in any aspect ratio, on any source. A `fit`
 * convention would have made `scale: 1` mean "letterboxed", and every framing the LLM
 * proposed would have depended on the shape of the footage it was proposed for.
 *
 * `x` and `y` translate the image as a fraction of the **output** frame, for the same
 * reason: a pan of 0.25 moves a quarter of the way across the screen whether the export is
 * 720p or 4K.
 */
export interface FrameSize {
  width: number;
  height: number;
}

export interface Placement {
  /** Region of the source to read, in source pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Where the centre of that region lands, in output pixels. */
  cx: number;
  cy: number;
  /** Size it is drawn at, in output pixels. */
  dw: number;
  dh: number;
  /** Clockwise, in radians. */
  rotation: number;
  opacity: number;
}

export interface Placeable {
  transform: TransformValue;
  crop: CropRect;
  opacity: number;
  /** Absent means ungraded, which is what every clip is until someone adjusts one. */
  color?: ColorValue | null;
}

export function placeLayer(layer: Placeable, source: FrameSize, out: FrameSize): Placement {
  const sx = layer.crop.left * source.width;
  const sy = layer.crop.top * source.height;
  const sw = Math.max(1, (layer.crop.right - layer.crop.left) * source.width);
  const sh = Math.max(1, (layer.crop.bottom - layer.crop.top) * source.height);

  const cover = Math.max(out.width / sw, out.height / sh);
  const scale = cover * layer.transform.scale;

  return {
    sx,
    sy,
    sw,
    sh,
    cx: out.width / 2 + layer.transform.x * out.width,
    cy: out.height / 2 + layer.transform.y * out.height,
    dw: sw * scale,
    dh: sh * scale,
    rotation: (layer.transform.rotation * Math.PI) / 180,
    opacity: layer.opacity,
  };
}

/**
 * The same framing, as a CSS transform for the preview element.
 *
 * The preview had no framing at all: a push-in the refinement pass proposed was invisible
 * until the export, which makes "accept this suggestion" a decision taken blind. This is
 * the counterpart of `filterFor` for geometry — one function, so the picture on screen and
 * the picture in the file cannot drift.
 *
 * `painted` is the size of the *picture inside the element*, not the element's own box. A
 * `<video>` with `object-fit: contain` letterboxes, so the element is usually taller or
 * wider than the frame it is showing, and `x` is a fraction of the frame. Translating by a
 * percentage of the element would pan by the wrong amount on any screen whose shape does
 * not happen to match the footage.
 *
 * Order matters and matches `drawLayer`: translate to where the centre goes, rotate about
 * it, then scale — which is what "translate, rotate, scale" reads as in CSS, since CSS
 * applies its list left to right about a common origin.
 */
export function previewTransform(transform: TransformValue, painted: FrameSize): string {
  const x = Math.round(transform.x * painted.width * 100) / 100;
  const y = Math.round(transform.y * painted.height * 100) / 100;
  const parts: string[] = [];
  if (x !== 0 || y !== 0) parts.push(`translate(${x}px, ${y}px)`);
  if (transform.rotation !== 0) parts.push(`rotate(${transform.rotation}deg)`);
  if (transform.scale !== 1) parts.push(`scale(${Math.round(transform.scale * 1000) / 1000})`);
  return parts.length > 0 ? parts.join(' ') : 'none';
}

/**
 * The size of the picture inside a `contain`-fitted element.
 *
 * Zero intrinsic size means the media has not loaded yet; the caller gets the box back so
 * nothing divides by zero on the way to showing nothing.
 */
export function paintedSize(box: FrameSize, intrinsic: FrameSize): FrameSize {
  if (intrinsic.width <= 0 || intrinsic.height <= 0 || box.width <= 0 || box.height <= 0) return box;
  const scale = Math.min(box.width / intrinsic.width, box.height / intrinsic.height);
  return { width: intrinsic.width * scale, height: intrinsic.height * scale };
}

/** The 2D drawing surface both a `canvas` and an `OffscreenCanvas` provide. */
export type Canvas2D = Pick<
  CanvasRenderingContext2D,
  'save' | 'restore' | 'translate' | 'rotate' | 'drawImage' | 'fillRect'
> & {
  globalAlpha: number;
  fillStyle: unknown;
  imageSmoothingQuality?: ImageSmoothingQuality;
  /**
   * Optional because not every 2D context has it — it arrived in Safari 17 — and because
   * an export that silently drops the grade is better than one that throws. Where it is
   * missing the picture is ungraded and everything else is exactly right, which is a
   * degradation someone can see and report rather than a file that never appears.
   */
  filter?: string;
};

/**
 * Paint one layer.
 *
 * Drawing happens around the centre — translate, rotate, then draw from `-dw/2` — because
 * a zoom that is not centred is a zoom that drifts, and computing a top-left corner for a
 * rotated, scaled image is the arithmetic this ordering exists to avoid.
 */
export function drawLayer(
  ctx: Canvas2D,
  image: CanvasImageSource,
  source: FrameSize,
  layer: Placeable,
  out: FrameSize,
): void {
  const at = placeLayer(layer, source, out);
  if (at.opacity <= 0) return;

  ctx.save();
  ctx.globalAlpha = Math.min(1, at.opacity);
  // The same string the preview puts in `style.filter`. Set inside the save/restore, so a
  // graded clip cannot leak its look onto the next layer.
  if ('filter' in ctx) ctx.filter = filterFor(layer.color);
  ctx.translate(at.cx, at.cy);
  if (at.rotation !== 0) ctx.rotate(at.rotation);
  ctx.drawImage(image, at.sx, at.sy, at.sw, at.sh, -at.dw / 2, -at.dh / 2, at.dw, at.dh);
  ctx.restore();
}

/** Fill the frame with the timeline's background. Every frame starts here. */
export function clearFrame(ctx: Canvas2D, out: FrameSize, background: string): void {
  ctx.save();
  ctx.globalAlpha = 1;
  // Explicitly, rather than trusting the last `restore`: the background is not footage and
  // must never carry a clip's grade.
  if ('filter' in ctx) ctx.filter = 'none';
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.restore();
}
