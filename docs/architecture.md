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

**`planLocalRefinement` is a stand-in, not the product.** It applies fixed heuristics —
trim a quarter-second off each join, push in on long static clips, speed up the very long
ones — where the real pass will listen to the audio and watch the footage. It exists
because the review screen is the piece that turns usage into labelled data, and that screen
could not be built, tested, or used before a provider was wired up. It satisfies the same
`CompleteFn` shape a model will, so replacing it is one function.

Its heuristics are deliberately conservative and capped at twelve edits. A pass that
proposes forty trains people to hit "accept all", and an accept-all is worth nothing as a
label. It also checks its own proposals apply cleanly before emitting them, because a
rejected op wastes a review slot.

### `@evocut/web` — coarse pass and review working, render screen not started

Vite + React, mobile-first, dark. Import a recording, scrub, split at the playhead, drop
and restore clips, freeze the coarse pass, review the refinement, export the EDL and the
log. Work is saved continuously and resumes after a reload.

There is intentionally no trim handle, no effect panel, no zoom control on the coarse
screen. The bet is that a person on a phone is good at one judgement — "is this bit worth
keeping?" — and that the refinement pass is what everything else is for.

The **review screen** is where usage becomes labelled data, and its design follows from
that. Nothing starts accepted: a screen that opens with every box ticked collects consent,
not judgement. Every op shows the rationale that came with it, because the stated reason is
as much what is being judged as the edit is. Applying with nothing accepted is a real
outcome rather than a no-op — it records that a human saw the suggestions and wanted none,
which is a stronger signal than never having asked.

Missing media is rendered as a state, not an error. The cut points are valid without the
footage, so a project whose bytes are gone shows a "find this file again" prompt and keeps
every clip intact when it is re-picked.

Not started: the render screen.

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
   repair loop, and the review screen are all built and exercised; `planLocalRefinement`
   is the only stand-in left. This needs a decision about where the call happens — calling
   a provider from the browser would expose the key, so it likely means a small server
   endpoint.
2. **The render pipeline.** `sampleTimeline` already says what each frame should be; what
   is missing is decode → composite → encode → mux.
3. **The training export.** Walk stored projects and logs into
   `(source features, coarse decisions, refinement verdicts)` records. `droppedRegions()`
   and `Revision.review` are the two starting points, and both are now populated by real
   use.
4. **Storage management.** `orphanedMedia()` exists but nothing calls it; a phone will
   fill up.
