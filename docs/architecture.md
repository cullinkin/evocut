# Architecture

## The shape of the thing

```
apps/web            packages/edl          packages/agent        packages/renderer
─────────           ────────────          ──────────────        ─────────────────
coarse pass    ──▶  Project / EDL    ──▶  refinement pass  ──▶  WebCodecs output
  (human)             + op engine           (proposed ops)        (own pipeline)
     │                    ▲                      │                      │
  review  ◀───────────────┼──────────────────────┘                      │
     │                    │                                             │
     └──── log ───────────┤                                             │
                          │                                             │
                    packages/store ──▶ training export ◀────────────────┘
                    (OPFS + IndexedDB)
```

`@evocut/edl` is the hub and depends on nothing but zod. Everything else depends on it and
not on each other, with one exception: the web app uses the renderer's sampling core for
preview, which is deliberate — see below.

## Package by package

### `@evocut/edl` — done

Schema, time model, op engine, validation, prompt rendering, digest, log. Runs unchanged
in a browser, a worker, and Node. Fully tested. Read [`docs/edl-spec.md`](./edl-spec.md).

### `@evocut/store` — done

Media in OPFS, projects and logs in IndexedDB. The split is about access pattern, not
taste: the renderer needs to stream a source lazily, which an OPFS file handle supports and
an IndexedDB blob does not, while projects and log rows need querying and partial updates,
which is the opposite.

Three decisions worth knowing:

**Media is fingerprinted, not hashed.** `fingerprintFile` reads the size and the first and
last 64KB. A real content hash would mean reading half a gigabyte before the editor opened
— and since WebCrypto has no streaming digest, holding all of it in memory at once. The
job is only to notice the same recording being picked twice, and both ends plus the length
does that.

**Log rows live in their own object store**, keyed by `[projectId, seq]`. The log grows
with every scrub, so rewriting the project document to append one row would make logging
quadratic — and logging has to stay cheap enough that nobody is tempted to make it sparse.

**A project that fails to parse throws rather than reporting itself absent.** Absent
invites the app to overwrite the user's work with a fresh project, which is worse than an
error message. The record stays in the database for a future migration to reach.

In-memory implementations of both stores ship alongside the real ones — not only as test
doubles, but because OPFS has no Node equivalent and without them the whole persistence
layer would be exercisable only in a browser. They validate on read exactly as the real
stores do; a double that is more forgiving than the real thing is worse than none.

### `@evocut/renderer` — working

`sampleTimeline(timeline, t)` answers "what is on screen and audible at output time t"
and returns the decode target, framing, crop, opacity, and gain. It is pure, tested, and
**used by the preview player and the export loop alike**.

That sharing is the point. The classic editor bug is two implementations of "what is on
screen at time t" — one for preview, one for export — that disagree at the edges. Here a
preview that looks right is evidence the export will be right.

It is also the completeness check on the EDL: if a frame cannot be described from the EDL
alone, the schema is missing something.

**How a frame is made.** The platform decodes and everything after that is ours. A
`<video>` element plays the source; each presented frame is drawn through `sampleClip`
onto a canvas; the canvas is encoded by `VideoEncoder` at the timeline's own frame rate;
`mp4.ts` writes the container. Output timestamps come from a frame counter, not from the
source, so the result is exactly constant-frame-rate however erratically the phone
recorded — and a speed change just consumes source frames faster while the output beat
holds steady.

Decoding through `VideoDecoder` instead would mean writing a demuxer for whatever an
iPhone produced: HEVC in QuickTime, with edit lists, rotation, and a variable frame rate.
The phone already contains a decoder that handles all of that. Writing a second one is a
project; writing the muxer is a file, and the muxer is the part with no platform
equivalent — WebCodecs encodes but does not package.

The cost is that capture runs at playback speed: a 90-second edit takes about 90 seconds.
Seeking per frame is exact and far slower, so it is kept as the fallback for browsers
without `requestVideoFrameCallback`.

**Audio is mixed, not captured.** Sources are decoded to PCM and scheduled against the
timeline in an `OfflineAudioContext`, so sync does not depend on the capture loop at all.
There is no music track by design — the sound is what the camera heard, and effects are
added afterwards elsewhere.

**Codecs.** AVC and AAC first, because the destination is an iPhone's camera roll and that
is what it takes. VP9 and Opus as the fallback for a browser without the licensed pair —
which includes the Chromium the export's own end-to-end check runs in, and that is what
makes the pipeline testable outside a phone at all.

**Why our own renderer.** The refinement pass emits sub-frame trims, speed changes, and
animated framing. Round-tripping that through a general-purpose editor's project format
loses exactly the precision the model was asked to supply. Decoding and encoding ourselves
also keeps the flow in the browser, so a phone never has to upload footage to get a result.

### `@evocut/signals` — working

Three measurements per recording: a loudness envelope, the transients in it, and how much
the picture moves. All in source time, so they belong to the recording rather than to any
edit of it and are computed once ever.

**Why it exists.** Until this, the refinement pass received a text description of the
timeline and nothing about the footage. Asked to put emphasis on the hits, a model in that
position can only guess — and a guess dressed up as a rationale ("adds energy here") is
worse than no suggestion at all, because it reads like observation.

**Crude on purpose.** RMS rather than LUFS, energy flux rather than spectral flux, mean
frame difference rather than optical flow. A phone has to compute these on footage it just
imported, and a crude number that is true beats a sophisticated one that takes forty
seconds. The limits are stated in the code: onsets are level transients, so a change of
tone at a steady volume is invisible, and motion cannot tell a moving camera from a moving
subject.

**Motion rides on the filmstrip.** The timeline already seeks through every source to build
thumbnails; that pass now also keeps a 32×32 greyscale copy of each frame. A second seek
loop over a whole recording, on a phone, would cost minutes to answer a yes-or-no question
about whether a shot is locked off.

**`summarize.ts` is where the timebase changes.** Measurements are in source time; ops are
in output time. Converting in one place means the model is never handed arithmetic to get
wrong on top of the judgement it is actually being asked for — and anything falling in
footage the coarse pass cut away is simply not mentioned, so there is nothing to place an
emphasis on that no longer exists.

### `@evocut/agent` — prompt and loop done, transport not started

Prompt construction, response validation against the EDL's own op schema, and the
apply/repair loop. `refineProject` takes a `complete` function rather than calling a
provider, so the loop is testable with a scripted model and the provider choice stays out
of the package.

The repair round is the notable part: rejected ops go back with their error messages and
an instruction not to resend the ones that landed. One round is usually enough, because
the common failure is a stale id and the error names it exactly.

**`planLocalRefinement` is a stand-in, not the product.** It exists because the review
screen is the piece that turns usage into labelled data, and that screen could not be
built, tested, or used before a provider was wired up. It satisfies the same `CompleteFn`
shape a model will, so replacing it is one function.

It reads the same signals a model does, and the difference is the argument for that
package in miniature. Blind, it trims a quarter-second off every join on principle and
pushes in on anything long. Measured, it trims to the edge of the silence it can actually
hear, times a push-in to arrive on a hit, and — the part that matters — *stops proposing*
at a join where it can tell there is nothing to trim.

Its heuristics are deliberately conservative and capped at twelve edits. A pass that
proposes forty trains people to hit "accept all", and an accept-all is worth nothing as a
label. It also checks its own proposals apply cleanly before emitting them, because a
rejected op wastes a review slot.

### `@evocut/web` — working

Vite + React, mobile-first, dark. A direct-manipulation timeline: drag the playhead, cut
at it, tap a clip to select it, drag either end to trim or to pull footage back out of the
original take, delete, undo. Work is saved continuously and resumes after a reload.

**This replaced an earlier design that deliberately had no trim handles.** That version
bet a person on a phone was good at exactly one judgement — "is this bit worth keeping?" —
and that everything finer belonged to the refinement pass. The bet was wrong in practice:
a coarse cut you cannot nudge is a coarse cut you make twice, and the refinement pass
cannot read your mind about which four frames were the problem. The two-pass model is
unchanged; what changed is that the first pass is now a real editor rather than a list.

#### Timeline mechanics worth knowing

**A gapless track pins clip starts.** Clip N begins wherever clip N-1 ends, so trimming
the head of a clip does not move its left edge — it changes the clip's *length*, and
everything after it shifts. That is why a trim drag captures the state it started from:
deriving the new edge from the clip's live position each frame feeds the drag into itself
and the handle accelerates away from the finger.

**One gesture, one op.** A trim drag renders from a local draft and emits a single `trim`
op on release. Committing per frame would bury the revision chain and the log under
gesture noise; what lands in the EDL should be the decision, not the finger movement.
Scrub logging is throttled to 4/second for the same reason, with the final position of
every drag always recorded.

**The headroom ghost is load-bearing.** The hatched band beside a selected clip is the
unused source on that side. Without it there is nothing on screen to say a clip can be
made longer, or by how much — "drag the end to extend" is invisible otherwise.

**Filmstrip frames are cached per source, not per clip**, so trimming changes which
cached frames are visible rather than invalidating a strip, and two clips from the same
take share one. Extraction runs in the background and the UI renders what has arrived.

#### iPhone specifics

The touch work is real work, not a media query. `touch-action` is set per element —
`pan-x` on the timeline lane so it scrolls, `none` on the playhead and trim handles so a
drag is a drag. That property is the only way to tell iOS a gesture is ours;
`preventDefault` on touchmove is both too late and too blunt. Handles hit-test at 44px
around a 12px paint, because a thumb is ~9mm and a trim handle cannot be. The layout is
`100dvh` with `env(safe-area-inset-*)` padding, the page itself never scrolls, and the
app ships a manifest and apple-touch-icon so it runs full-screen from the home screen.

`packages/store` also feature-detects OPFS `createWritable` rather than checking for OPFS
at all: iOS Safari exposed OPFS reads well before it could be written to, so the naive
check reports success on an iPhone and then fails on the first import. Where it is
missing, media falls back to IndexedDB blobs.

The **review screen** is where usage becomes labelled data, and its design follows from
that. Nothing starts accepted: a screen that opens with every box ticked collects consent,
not judgement. Every op shows the rationale that came with it, because the stated reason is
as much what is being judged as the edit is. Applying with nothing accepted is a real
outcome rather than a no-op — it records that a human saw the suggestions and wanted none,
which is a stronger signal than never having asked.

Missing media is rendered as a state, not an error. The cut points are valid without the
footage, so a project whose bytes are gone shows a "find this file again" prompt and keeps
every clip intact when it is re-picked.

**The export owns the screen while it runs.** It takes about as long as the video is and
the tab has to stay in front for it, so a progress bar tucked into the corner of a live
editor would invite exactly the tab switch that stalls the capture. When it finishes,
Share comes before Download: on iOS the share sheet has "Save Video" at the top, while a
download lands in Files, several taps from anywhere useful.

## Decisions worth knowing about

**Ops, not documents.** The model emits discrete edits, never a rewritten timeline. This
is the single most load-bearing decision in the system; the reasoning is in the EDL spec.

**Partial failure everywhere.** `applyOps` skips bad ops and reports them. `parseLog`
skips bad lines and collects them. Both are cases where the alternative — throwing —
discards data that cannot be recreated.

**Injectable ids and clocks.** Every factory takes `newId` and `now`. Two things must be
reproducible: the test suite, and replaying a log back into the timeline it produced.
Reaching for `Date.now()` inside a factory forfeits both.

**Human and model edits share one history.** A coarse-pass split and a refinement trim are
both `Op`s in a `Revision`. That is what makes `by: 'human'` versus `by: 'llm'` a
meaningful distinction rather than a label.

**The log is an output, not a debug aid.** It is the record of how a coarse pass was made,
and the reason it can become a training set later. The web app exports it next to the EDL.

## Working on it

```bash
npm install
npm test            # all packages
npm run typecheck   # all packages
npm run dev         # the web app, reachable from a phone on the same network
npm run build       # edl → renderer → agent → web, in dependency order
```

Packages typecheck and test against each other's **source** (via tsconfig `paths` and
vitest/vite aliases), so a schema change surfaces immediately. The build resolves the
built package instead, which is what a consumer actually sees — so `npm run build` is the
check that the package boundaries are real.

## What to do next

1. **Wire a real model behind the refinement pass.** The prompt, the tool schema, the
   repair loop, the signals, and the review screen are all built and exercised;
   `planLocalRefinement` is the only stand-in left. This needs a decision about where the
   call happens — calling a provider from the browser would expose the key, so it likely
   means a small server endpoint.
2. **A style brief.** The signals say what is in the footage; nothing yet says what the
   result should feel like. A reference video is inert to a model — the useful form is a
   written brief, and eventually the person's own accepted and rejected EDLs as examples.
3. **The training export.** Walk stored projects and logs into
   `(source features, coarse decisions, refinement verdicts)` records. `droppedRegions()`
   and `Revision.review` are the two starting points, and both are now populated by real
   use.
4. **Storage management.** `orphanedMedia()` exists but nothing calls it; a phone will
   fill up.
