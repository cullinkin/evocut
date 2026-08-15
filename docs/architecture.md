# Architecture

## The shape of the thing

```
apps/web            packages/edl          packages/agent        packages/renderer
─────────           ────────────          ──────────────        ─────────────────
coarse pass    ──▶  Project / EDL    ──▶  refinement pass  ──▶  WebCodecs output
  (human)             + op engine           (LLM ops)             (own pipeline)
     │                    ▲                      │                      │
     └──── log ───────────┴──────────────────────┘                      │
                          │                                             │
                    training export ◀───────────────────────────────────┘
```

`@evocut/edl` is the hub and depends on nothing but zod. Everything else depends on it and
not on each other, with one exception: the web app uses the renderer's sampling core for
preview, which is deliberate — see below.

## Package by package

### `@evocut/edl` — done

Schema, time model, op engine, validation, prompt rendering, digest, log. Runs unchanged
in a browser, a worker, and Node. Fully tested. Read [`docs/edl-spec.md`](./edl-spec.md).

### `@evocut/renderer` — sampling core done, pipeline not started

`sampleTimeline(timeline, t)` answers "what is on screen and audible at output time t"
and returns the decode target, framing, crop, opacity, and gain. It is pure, tested, and
**used by the preview player as well as the future export loop**.

That sharing is the point. The classic editor bug is two implementations of "what is on
screen at time t" — one for preview, one for export — that disagree at the edges. Here a
preview that looks right is evidence the export will be right.

It is also the completeness check on the EDL: if a frame cannot be described from the EDL
alone, the schema is missing something.

Still to build: the WebCodecs decode → composite → encode → mux pipeline. The interfaces
(`Renderer`, `MediaResolver`, `RenderRequest`) are pinned because they are the contract
the sampling core was designed against.

**Why our own renderer.** The refinement pass emits sub-frame trims, speed changes, and
animated framing. Round-tripping that through a general-purpose editor's project format
loses exactly the precision the model was asked to supply. Decoding and encoding ourselves
also keeps the flow in the browser, so a phone never has to upload footage to get a result.

### `@evocut/agent` — prompt and loop done, transport not started

Prompt construction, response validation against the EDL's own op schema, and the
apply/repair loop. `refineProject` takes a `complete` function rather than calling a
provider, so the loop is testable with a scripted model and the provider choice stays out
of the package.

The repair round is the notable part: rejected ops go back with their error messages and
an instruction not to resend the ones that landed. One round is usually enough, because
the common failure is a stale id and the error names it exactly.

### `@evocut/web` — coarse pass working, everything else not started

Vite + React, mobile-first, dark. Import a recording, scrub, split at the playhead, drop
and restore clips, freeze the coarse pass, export the EDL and the log.

There is intentionally no trim handle, no effect panel, no zoom control. The bet is that a
person on a phone is good at one judgement — "is this bit worth keeping?" — and that the
refinement pass is what everything else is for.

Not started: persistence (the media locator is `unresolved`, so reopening needs a
re-pick), the refinement review screen, and the render screen.

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

1. **Persist media and projects.** OPFS for the footage, IndexedDB for the EDL. Until this
   lands, closing the tab loses the session, which makes the coarse pass hard to dogfood.
2. **The refinement review screen.** Ops arrive with rationales; show them as a list the
   user accepts or rejects per-op, and write the verdict to `Revision.accepted`. This is
   what turns usage into labelled data.
3. **The render pipeline.** `sampleTimeline` already says what each frame should be.
4. **The training export.** Walk a directory of projects and logs into
   `(source features, coarse decisions)` pairs. `droppedRegions()` is the starting point.
