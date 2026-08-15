# The EvoCut EDL

The edit decision list is the contract between the four parts of EvoCut: the mobile
coarse-cut app writes one, the refinement pass edits one, the renderer reads one, and the
training export mines them. Everything else can be rewritten; this is the piece that has
to be right first.

Implementation: [`packages/edl`](../packages/edl). This document explains the decisions;
the source explains the details.

---

## The two-pass model

```
  recording ──▶ coarse pass ──▶ handoff ──▶ refinement pass ──▶ render
                 (human)         (freeze)      (LLM)            (own renderer)
                    │                             │
                    └───────── log + EDL ─────────┴──▶ training set
```

A person on a phone decides **what the video is about** by keeping the footage worth
using. A model then decides **how it plays** — trimming the breath off each cut, killing
dead air, speeding up a walk-over, adding a slow push-in on a locked-off shot.

The split is the product. The human judgement is fast and hard to automate; the
refinement work is slow, fiddly, and exactly what a model is good at. The EDL has to
serve both without either one having to understand the other's representation.

## Time

**Every time in the EDL is an integer count of microseconds.** No floats, no seconds, no
timecode strings.

- WebCodecs timestamps are microseconds, and the renderer is built on WebCodecs, so
  nothing converts at render time.
- Integers survive JSON, hashing, and diffing exactly. `1/3` of a second written as a
  float and read back is not the same cut point it was; the digest changes and a replay
  diverges.
- A microsecond is about 1/33000 of a frame at 30fps — lossless for anything we render.

Frame rates are rationals, `{num, den}`. 29.97 is not a number, it is 30000/1001, and a
float loses about 3.6ms per hour against the real rate. `packages/edl/test/time.test.ts`
pins that difference so nobody "simplifies" it later.

Cut points are **not** snapped to frames when they are made. A cut made by dragging on a
phone lands between frames, and that sub-frame position is real signal about where the
person actually pointed. `snapTimelineToFrames()` rounds at render time; the EDL keeps
the gesture.

## Entities

| Entity | What it is |
| --- | --- |
| `Source` | An immutable recording. Never edited. Holds duration, stream info, and a *locator hint*. |
| `Clip` | One contiguous region of a source, placed on the timeline. |
| `Track` | An ordered list of clips. v1 produces exactly one `video` track. |
| `Timeline` | Output format plus tracks. |
| `Project` | Sources, the live timeline, the frozen coarse snapshot, and the revision chain. |
| `Op` | One discrete edit. The unit the LLM emits. |
| `Revision` | A batch of ops that were applied, with who made them and why. |
| `LogEvent` | An append-only record of what happened during the coarse pass. |

Ids are prefixed — `clp_`, `trk_`, `src_`, `fx_`. This is not decoration: ops reference
ids as bare strings, and a track id where a clip id belongs is the single most likely
model error. The prefix makes it a schema failure instead of a confusing runtime one.

### Sources and the locator problem

On mobile web, media does not have a stable identity. A `blob:` URL dies with the page. An
OPFS handle is origin-scoped. An uploaded object exists only after a sync.

So `Source.locator` is a *hint* about where the bytes were last seen, and re-binding it to
real bytes on load is the app's job. The EDL stays valid and portable either way — the
cut points do not depend on the media being reachable.

### Clips carry both timebases

A clip stores its source range (`sourceIn`/`sourceOut`, half-open) **and** its position on
the output timeline (`start`). The position is derivable by walking the track, so this is
redundant — deliberately.

- The renderer and the model never have to do that walk.
- A corrupted position becomes a validation error (`position-drift`) instead of a silent
  misrender.

`normalizeTimeline()` recomputes it. On a `video` track, clips are contiguous: remove one
and everything after ripples left, which is the mental model of the coarse pass. Audio and
overlay tracks keep their explicit positions — music does not ripple when you cut a take.

A disabled clip occupies no output time. Otherwise toggling one off would leave a hole of
black where it used to be.

### Speed lives on the clip, not in effects

`outputDuration = (sourceOut - sourceIn) / speed`. Speed changes the clip's footprint on
the timeline, so everything downstream has to reflow when it changes — which makes it a
structural property, not a filter.

### Effects are keyframed in output time

Keyframe `t` is measured from the clip's start **on the output timeline**, after speed is
applied. A 10s source region at 2x is a 5s clip, and a keyframe at `t = 5_000_000` sits at
its very end.

This is the rendered timebase rather than the source timebase because both the scrubber
the user sees and the model's own description of an edit ("push in over the last two
seconds") are in rendered time. Anchoring to source time would mean every speed change
silently slid every zoom.

`TransformValue.scale` is a pure zoom factor where `1` fits the frame, and `x`/`y` are
fractions of the output frame. A pan therefore reads the same at any resolution and
survives a change of export size.

## Ops: the edit language

**The LLM never writes a timeline.** It emits ops against clip ids, and the engine applies
them. Three reasons:

1. **It cannot drift.** A model asked to return a whole EDL will renumber a `start`, drop
   a clip, or invent a source id. Ops touch one thing each and are checked against the
   timeline they are applied to.
2. **Every change is reviewable.** An op list is a diff. The user can see "trimmed 0.4s of
   silence off the head of clip 3" and reject that one op.
3. **It is the training signal.** `(coarse timeline, ops, accepted?)` is the triple worth
   learning from, and it only exists if refinement is expressed as discrete decisions.

```
trim  split  remove  setEnabled  move  setSpeed
addEffect  removeEffect  setAudio  setLabel  insertClip
```

Times in ops are on the output timeline unless the field name says `source` — matching
what the model was shown.

### Failure is partial, never fatal

`applyOps` skips a bad op and keeps going. A refinement pass is twenty ops and the model
will get one wrong — a stale clip id after its own earlier split, a trim four frames past
the end. Throwing would discard nineteen good edits. Instead the result carries `applied`
and `errors`, and the errors are exactly what a repair round needs.

Ops are applied in order against the running result and the timeline is renormalized after
each one, so a `split` at an absolute time behaves correctly even after an earlier
`remove` rippled everything left.

### The tool schema is generated, not written

`refinementToolDefinition()` derives the model's `input_schema` from the same zod schema
the engine validates against. Hand-writing a JSON Schema for the prompt and validating
with a separate one guarantees they drift, and the failure mode is a model dutifully
producing output the engine rejects.

## Provenance and the training set

Three mechanisms, each covering a different way the signal could be lost:

**`coarseSnapshot`** — the human's timeline, frozen at handoff by `freezeCoarsePass()`.
Once refinement ops land on the live timeline there is no way to recover which cuts were
the human's. This is the one moment it can be captured, and it is stored rather than
reconstructed so it survives log truncation or any future compaction of `revisions`.

**`revisions`** — a linear chain of `(parentId, by, ops, review?)`. The timeline at any
point is replayable from the import plus ops, so the training export can re-derive rather
than trust a snapshot.

`Revision.ops` is what was *applied*. After a review that is the accepted subset, and the
full proposal lives in `Revision.review.verdicts` — one `{op, accepted, note?}` per
suggestion. Storing rejections explicitly is the whole point: an op the user waved away
leaves no mark on the timeline, so the verdict is the only trace it ever gets, and the
rejections are as much of the label as the acceptances. `Revision.accepted` is the coarser
pass-level roll-up ("did the human keep anything from this pass?"), stored separately so a
training export can filter without walking every verdict.

**The log** (`LogEvent`, JSONL) — where the user scrubbed, what they watched twice, which
cut they made and undid. A finished EDL cannot tell you whether a cut point was deliberate
or the first thing they tried. Two consequences:

- `payload` is an open record. Validation happens on *read*, not write: a schema mismatch
  at write time drops an event we can never re-record, while a mismatch at read time is
  one skipped row. `parseLog` collects bad lines instead of throwing them away, so a phone
  losing the tab mid-append costs one line, not the session.
- Every event carries the playhead. Attention is the signal.

`droppedRegions()` gives the complement — what the human threw away — which is the other
half of the keep-or-drop label.

## Validation

Two layers, because they fail differently:

- **zod** checks shape. A non-integer time, an unknown op kind, a mistyped id prefix.
- **`validateTimeline`** checks meaning: source bounds, duplicate ids, overlaps, position
  drift, keyframes past the end of their clip. It reports *all* issues rather than dying
  on the first, because the caller is often a model doing a repair round and one error per
  pass means one round trip per mistake.

Issues carry a severity. Frame misalignment is a warning and is off by default — during
the coarse pass it is expected, not a defect.

## Versioning

`schemaVersion` is a literal, currently `1`. Parsing a document with a different version
fails rather than best-effort loading it. Migrations get added when there is a second
version to migrate from.
