# EvoCut

LLM-aided video editing. A person makes the coarse pass on their phone — keeping only the
footage worth using — and a model refines what survives: tightening cuts, killing dead
air, speeding up the boring parts, adding motion to static shots. EvoCut renders the
result itself rather than exporting to another editor.

```
  recording ──▶ coarse pass ──▶ handoff ──▶ refinement pass ──▶ render
                 (human)         (freeze)      (LLM)          (own renderer)
                    │                             │
                    └───────── log + EDL ─────────┴──▶ training set
```

The split is the product bet: a person is fast at deciding *what the video is about* and
slow at everything else, and "everything else" is exactly what a model is good at. Every
coarse pass is also logged as an EDL, so the accumulated sessions become a training set
for automating the first pass later.

## Status

| | |
| --- | --- |
| `packages/edl` | **Working.** Schema, time model, op engine, validation, log. 86 tests. |
| `packages/store` | **Working.** OPFS media (IndexedDB fallback), projects and logs. 38 tests. |
| `packages/renderer` | **Sampling core working**, WebCodecs pipeline not started. |
| `packages/agent` | **Prompt, repair loop, and a local stand-in planner.** No provider wired. |
| `apps/web` | **Timeline editor and refinement review working.** No render screen. |

Early prototype. The EDL is the piece everything else depends on, so it was built first
and properly; the rest is scaffolding of varying thickness around it.

The refinement pass currently runs a **local heuristic planner**, not a model — see
`packages/agent/src/local.ts`. It exists so the review screen can be built and used
before a provider is wired up; swapping it for a real model is one function.

## Quick start

```bash
npm install
npm test
npm run dev     # then open the printed network URL on a phone
```

The coarse pass works like an editor: drag the playhead, **Cut** at it, tap a clip to
select it, then drag either end to trim — or to pull footage back out of the original take,
which the hatched band beside the clip shows you the reach of. **Delete** and **Undo** do
what you expect. **Done** freezes the pass; **Refine** then proposes edits, each with a
reason, and you keep or skip them one at a time. **Export EDL** and **Export log** give you
the two artefacts.

Built for a phone: full-screen layout with safe-area insets, 44px touch targets, real
touch-drag gestures that iOS will not steal, and a manifest so it runs from the home
screen without Safari's chrome.

Everything is stored on the device — footage in OPFS, projects and logs in IndexedDB — so
closing the tab and coming back resumes where you left off. Nothing is uploaded anywhere.

## Layout

```
packages/edl/         the edit decision list — schema, ops, validation, log
packages/store/       local persistence: OPFS media, IndexedDB projects and logs
packages/renderer/    output pipeline; currently the pure sampling core
packages/agent/       refinement pass: prompts, op validation, repair rounds
apps/web/             mobile web app for the coarse pass
apps/web/e2e/         browser checks: real touch gestures on an iPhone profile
docs/edl-spec.md      the EDL model and why it is shaped this way
docs/architecture.md  how the pieces fit, and what to build next
```

## Reading order

Start with [`docs/edl-spec.md`](docs/edl-spec.md) — it explains the two-pass model, why
times are integer microseconds, and why the model emits ops instead of timelines. Then
[`docs/architecture.md`](docs/architecture.md) for the package boundaries and the next
steps.
