import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  commitOps,
  createClip,
  createProject,
  createTimeline,
  createTrack,
  freezeCoarsePass,
  makeIdFactory,
  makeLogger,
  projectFromSource,
  secondsToMicros as S,
  type LogEvent,
  type Project,
  type Source,
} from '@evocut/edl';
import {
  CorruptProjectError,
  IdbConnection,
  IdbDerivedCache,
  IdbMediaIndex,
  IdbProjectStore,
  IdbSettingsStore,
} from '../src/idb.js';
import {
  MemoryDerivedCache,
  MemoryMediaStore,
  MemoryProjectStore,
  MemorySettingsStore,
} from '../src/memory.js';
import { IdbMediaStore } from '../src/idb-media.js';
import { indexKeyFor } from '../src/fingerprint.js';
import { bindProjectMedia, orphanedMedia, rebindSource } from '../src/bind.js';
import { fingerprintFile, mediaPath } from '../src/fingerprint.js';
import { fingerprintFromPath, mimeFromFilename } from '../src/media-file.js';
import type { MediaStore, ProjectStore } from '../src/types.js';

function deps(seed = 's') {
  let tick = 0;
  return {
    newId: makeIdFactory(seed),
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
  };
}

function makeFile(name: string, contents: string, type = 'video/mp4'): File {
  return new File([contents], name, { type });
}

/** A logger with valid, deterministic event ids for one project. */
function eventLogger(projectId: string) {
  let n = 0;
  return makeLogger(projectId, () => `evt_${projectId.replace(/[^a-z0-9]/gi, '')}${++n}`, () =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  );
}

const source: Source = {
  id: 'src_take1',
  locator: { kind: 'opfs', path: 'media/abc' },
  name: 'take1.mp4',
  duration: S(60),
};

function makeProject(): Project {
  const d = deps();
  const clips = [
    createClip({ sourceId: 'src_take1', sourceIn: S(2), sourceOut: S(10), label: 'intro' }, d),
    createClip({ sourceId: 'src_take1', sourceIn: S(18), sourceOut: S(30), label: 'demo' }, d),
  ];
  const timeline = createTimeline({ tracks: [createTrack({ kind: 'video', clips }, d)] }, d);
  return createProject({ name: 'take1', sources: [source], timeline }, d);
}

describe('fingerprintFile', () => {
  it('is stable for identical content', async () => {
    const a = await fingerprintFile(makeFile('a.mp4', 'the same bytes'));
    const b = await fingerprintFile(makeFile('renamed.mp4', 'the same bytes'));
    // Not keyed on the filename, so footage re-picked from another folder still dedupes.
    expect(a).toBe(b);
  });

  it('differs on content and on length', async () => {
    const a = await fingerprintFile(makeFile('a.mp4', 'one recording'));
    const b = await fingerprintFile(makeFile('a.mp4', 'another recor'));
    const c = await fingerprintFile(makeFile('a.mp4', 'one recording plus more'));
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('encodes the size, so same-length collisions still need matching ends', async () => {
    const fingerprint = await fingerprintFile(makeFile('a.mp4', 'abcdef'));
    expect(fingerprint.slice(0, 12)).toBe((6).toString(16).padStart(12, '0'));
  });

  it('handles an empty file without reading past the end', async () => {
    await expect(fingerprintFile(makeFile('empty.mp4', ''))).resolves.toMatch(/^0{12}/);
  });
});

describe('MemoryMediaStore', () => {
  it('stores and retrieves a file by path', async () => {
    const media = new MemoryMediaStore();
    const record = await media.put(makeFile('take1.mp4', 'footage'));

    expect(record.path).toBe(mediaPath(record.fingerprint));
    expect(await media.has(record.path)).toBe(true);
    expect(await (await media.get(record.path))!.text()).toBe('footage');
  });

  it('deduplicates a re-import instead of copying again', async () => {
    const media = new MemoryMediaStore();
    const first = await media.put(makeFile('take1.mp4', 'footage'));
    const second = await media.put(makeFile('take1-copy.mp4', 'footage'));

    expect(second.path).toBe(first.path);
    // The first import's metadata wins, so a re-pick does not rewrite history.
    expect(second.filename).toBe('take1.mp4');
    expect(await media.list()).toHaveLength(1);
  });

  it('reports usage and forgets deleted media', async () => {
    const media = new MemoryMediaStore();
    const record = await media.put(makeFile('take1.mp4', 'footage'));
    expect(await media.usage()).toBe(7);

    await media.delete(record.path);
    expect(await media.get(record.path)).toBeNull();
    expect(await media.usage()).toBe(0);
  });
});

/** Both implementations have to behave identically, so they run the same suite. */
describe.each([
  ['MemoryProjectStore', () => new MemoryProjectStore()],
  ['IdbProjectStore', () => new IdbProjectStore(new IdbConnection(new IDBFactory()))],
])('%s', (_name, create) => {
  let store: ProjectStore;

  beforeEach(() => {
    store = create();
  });

  it('round-trips a project', async () => {
    const project = makeProject();
    await store.save(project);
    expect(await store.load(project.id)).toEqual(project);
  });

  it('returns null for a project it does not have', async () => {
    expect(await store.load('prj_nope')).toBeNull();
  });

  it('overwrites on save rather than accumulating', async () => {
    const project = makeProject();
    await store.save(project);
    await store.save({ ...project, name: 'renamed' });

    expect((await store.load(project.id))!.name).toBe('renamed');
    expect(await store.list()).toHaveLength(1);
  });

  it('preserves the frozen coarse snapshot and review verdicts', async () => {
    const d = deps('p');
    const frozen = freezeCoarsePass(makeProject(), d);
    const clipId = frozen.timeline.tracks[0]!.clips[0]!.id;
    const proposal = { op: 'trim' as const, clipId, sourceIn: S(2.4), rationale: 'inhale' };
    const rejected = { op: 'remove' as const, clipId, rationale: 'too long' };

    const { project } = commitOps(frozen, [proposal], {
      by: 'llm',
      review: {
        verdicts: [
          { op: proposal, accepted: true },
          { op: rejected, accepted: false, note: 'I need that' },
        ],
      },
      ...d,
    });

    await store.save(project);
    const loaded = (await store.load(project.id))!;

    // The two things the training set actually depends on have to survive storage.
    expect(loaded.coarseSnapshot!.tracks[0]!.clips[0]!.sourceIn).toBe(S(2));
    expect(loaded.revisions.at(-1)!.review!.verdicts).toHaveLength(2);
    expect(loaded.revisions.at(-1)!.accepted).toBe(true);
  });

  it('summarises projects newest first, counting only kept clips', async () => {
    const a = { ...makeProject(), id: 'prj_a', name: 'older', updatedAt: '2026-01-01T00:00:00.000Z' };
    const b = { ...makeProject(), id: 'prj_b', name: 'newer', updatedAt: '2026-02-01T00:00:00.000Z' };
    b.timeline = {
      ...b.timeline,
      tracks: [
        {
          ...b.timeline.tracks[0]!,
          clips: b.timeline.tracks[0]!.clips.map((c, i) => (i === 0 ? { ...c, enabled: false } : c)),
        },
      ],
    };

    await store.save(a);
    await store.save(b);

    const summaries = await store.list();
    expect(summaries.map((s) => s.name)).toEqual(['newer', 'older']);
    expect(summaries[0]!.clipCount).toBe(1);
    expect(summaries[1]!.clipCount).toBe(2);
  });

  it('appends log events and reads them back in sequence order', async () => {
    const project = makeProject();
    const log = eventLogger(project.id);
    const events: LogEvent[] = [
      log('project.create', 'human'),
      log('playback.seek', 'human', { playhead: S(4) }),
      log('clip.split', 'human', { playhead: S(4) }),
    ];

    // Appended out of order, as a flush of buffered events could be.
    await store.appendEvents([events[2]!, events[0]!]);
    await store.appendEvents([events[1]!]);

    const read = await store.readEvents(project.id);
    expect(read.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(read[2]!.type).toBe('clip.split');
  });

  it('does not duplicate an event replayed with the same sequence number', async () => {
    const project = makeProject();
    const log = eventLogger(project.id);
    const event = log('playback.seek', 'human', { playhead: S(1) });

    await store.appendEvents([event]);
    await store.appendEvents([event]);

    expect(await store.readEvents(project.id)).toHaveLength(1);
  });

  it('keeps each project’s log separate', async () => {
    const a = makeProject();
    const b = { ...makeProject(), id: 'prj_other' };
    const logA = eventLogger(a.id);
    const logB = eventLogger(b.id);

    await store.appendEvents([logA('project.create', 'human'), logB('project.create', 'human')]);

    expect(await store.readEvents(a.id)).toHaveLength(1);
    expect(await store.readEvents(b.id)).toHaveLength(1);
  });

  it('deletes a project along with its log and last-opened pointer', async () => {
    const project = makeProject();
    const log = eventLogger(project.id);

    await store.save(project);
    await store.appendEvents([log('project.create', 'human'), log('playback.seek', 'human')]);
    await store.setLastOpened(project.id);

    await store.delete(project.id);

    expect(await store.load(project.id)).toBeNull();
    expect(await store.readEvents(project.id)).toEqual([]);
    expect(await store.getLastOpened()).toBeNull();
  });

  it('remembers which project to reopen', async () => {
    expect(await store.getLastOpened()).toBeNull();
    await store.setLastOpened('prj_a');
    expect(await store.getLastOpened()).toBe('prj_a');
    await store.setLastOpened(null);
    expect(await store.getLastOpened()).toBeNull();
  });
});

describe('IdbProjectStore corruption handling', () => {
  it('throws rather than reporting a broken project as missing', async () => {
    // Reporting it absent would invite the app to overwrite the user's work with a
    // fresh project, which is the one outcome worse than an error message.
    const factory = new IDBFactory();
    const store = new IdbProjectStore(new IdbConnection(factory));
    const project = makeProject();
    await store.save(project);
    await store.save({ ...project, schemaVersion: 99 } as unknown as Project);

    await expect(store.load(project.id)).rejects.toThrow(CorruptProjectError);
  });

  it('skips a broken project in the list instead of failing the whole list', async () => {
    const store = new IdbProjectStore(new IdbConnection(new IDBFactory()));
    await store.save(makeProject());
    await store.save({ id: 'prj_broken', junk: true } as unknown as Project);

    const summaries = await store.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.name).toBe('take1');
  });
});

describe('IdbMediaIndex', () => {
  it('round-trips and deletes records', async () => {
    const index = new IdbMediaIndex(new IdbConnection(new IDBFactory()));
    const record = {
      fingerprint: 'abc',
      path: 'media/abc',
      filename: 'take1.mp4',
      sizeBytes: 100,
      importedAt: '2026-01-01T00:00:00.000Z',
    };

    await index.put(record);
    expect(await index.get('abc')).toEqual(record);
    expect(await index.list()).toEqual([record]);

    await index.delete('abc');
    expect(await index.get('abc')).toBeNull();
  });
});

describe('binding media back to a loaded project', () => {
  it('produces a playable url when the media is still there', async () => {
    const media = new MemoryMediaStore();
    const record = await media.put(makeFile('take1.mp4', 'footage'));
    const project = rebindSource(makeProject(), 'src_take1', record.path, record.fingerprint);

    const bound = await bindProjectMedia(project, media);
    expect(bound.missing).toEqual([]);
    expect(bound.urls.get('src_take1')).toMatch(/^blob:/);
  });

  it('reports missing media as a state, not an error', async () => {
    // The cut points are still valid without the footage; the app has to render this,
    // not crash on it.
    const bound = await bindProjectMedia(makeProject(), new MemoryMediaStore());
    expect(bound.urls.size).toBe(0);
    expect(bound.missing).toEqual([
      { sourceId: 'src_take1', filename: 'take1.mp4', durationUs: S(60) },
    ]);
  });

  it('treats an unresolved locator as missing', async () => {
    const project = makeProject();
    project.sources[0]!.locator = { kind: 'unresolved', filename: 'take1.mp4' };
    const bound = await bindProjectMedia(project, new MemoryMediaStore());
    expect(bound.missing).toHaveLength(1);
  });

  it('keeps clips valid when a source is rebound', async () => {
    const project = makeProject();
    const rebound = rebindSource(project, 'src_take1', 'media/new', 'fp_new');

    expect(rebound.sources[0]!.locator).toEqual({ kind: 'opfs', path: 'media/new' });
    expect(rebound.sources[0]!.contentHash).toBe('fp_new');
    // The source keeps its id, so nothing on the timeline had to move.
    expect(rebound.timeline).toEqual(project.timeline);
  });

  it('finds media no project references any more', async () => {
    const media = new MemoryMediaStore();
    const used = await media.put(makeFile('used.mp4', 'kept footage'));
    const orphan = await media.put(makeFile('orphan.mp4', 'abandoned footage'));
    const project = rebindSource(makeProject(), 'src_take1', used.path, used.fingerprint);

    expect(await orphanedMedia([project], media)).toEqual([orphan.path]);
  });
});

describe('the import path end to end', () => {
  it('survives a save, a reload, and a rebind', async () => {
    const media = new MemoryMediaStore();
    const projects = new MemoryProjectStore();
    const d = deps('i');

    const record = await media.put(makeFile('take1.mp4', 'real footage bytes'));
    const imported = projectFromSource(
      { ...source, locator: { kind: 'opfs', path: record.path }, contentHash: record.fingerprint },
      {},
      d,
    );

    await projects.save(imported);
    await projects.setLastOpened(imported.id);

    // A fresh launch: find the last project, load it, find its media.
    const reopened = await projects.load((await projects.getLastOpened())!);
    const bound = await bindProjectMedia(reopened!, media);

    expect(reopened!.timeline.tracks[0]!.clips[0]!.sourceOut).toBe(S(60));
    expect(bound.missing).toEqual([]);
    expect(bound.urls.size).toBe(1);
  });
});

describe('IdbMediaStore', () => {
  it('behaves like the OPFS store for browsers that cannot write to OPFS', async () => {
    // iOS Safari exposed OPFS reads before `createWritable`, so this path is what an
    // older iPhone actually runs. It has to satisfy the same contract.
    const connection = new IdbConnection(new IDBFactory());
    const media = new IdbMediaStore(connection, new IdbMediaIndex(connection));

    const record = await media.put(makeFile('take1.mp4', 'footage'));
    expect(record.path).toBe(mediaPath(record.fingerprint));
    expect(await media.has(record.path)).toBe(true);

    const readBack = await media.get(record.path);
    expect(await readBack!.text()).toBe('footage');
    expect(readBack!.name).toBe('take1.mp4');
    expect(readBack!.type).toBe('video/mp4');

    // Same dedupe behaviour as OPFS.
    const again = await media.put(makeFile('take1-copy.mp4', 'footage'));
    expect(again.path).toBe(record.path);
    expect(await media.list()).toHaveLength(1);
    expect(await media.usage()).toBe(7);

    await media.delete(record.path);
    expect(await media.get(record.path)).toBeNull();
    expect(await media.list()).toEqual([]);
  });

  it('binds a loaded project to media it holds', async () => {
    const connection = new IdbConnection(new IDBFactory());
    const media = new IdbMediaStore(connection, new IdbMediaIndex(connection));
    const record = await media.put(makeFile('take1.mp4', 'footage'));
    const project = rebindSource(makeProject(), 'src_take1', record.path, record.fingerprint);

    const bound = await bindProjectMedia(project, media);
    expect(bound.missing).toEqual([]);
    expect(bound.urls.get('src_take1')).toMatch(/^blob:/);
  });
});

describe('media identity survives storage', () => {
  // The bug this pins: media is stored at `media/<fingerprint>` with no extension, and
  // both backends derive a File's name and type from that path. Chromium sniffs the
  // container out of the bytes and plays it anyway; Safari refuses to decode an untyped
  // blob URL, so an iPhone got "Could not read 000002eeec…" on every import while every
  // test passed. The type has to be carried in the index and reapplied on the way out.
  const backends: Array<[string, () => MediaStore]> = [
    ['MemoryMediaStore', () => new MemoryMediaStore()],
    [
      'IdbMediaStore',
      () => {
        const connection = new IdbConnection(new IDBFactory());
        return new IdbMediaStore(connection, new IdbMediaIndex(connection));
      },
    ],
  ];

  it.each(backends)('%s gives back the original name and MIME type', async (_name, create) => {
    const media = create();
    const record = await media.put(makeFile('IMG_0421.MOV', 'footage', 'video/quicktime'));

    const readBack = (await media.get(record.path))!;
    expect(readBack.name).toBe('IMG_0421.MOV');
    expect(readBack.type).toBe('video/quicktime');
    expect(await readBack.text()).toBe('footage');
  });

  it.each(backends)('%s infers a type when the picker did not set one', async (_name, create) => {
    // iOS hands .MOV out of the Photos picker and does not always set a type.
    const media = create();
    const record = await media.put(new File(['footage'], 'clip.mov', {}));

    expect(record.mimeType).toBe('video/quicktime');
    expect((await media.get(record.path))!.type).toBe('video/quicktime');
  });

  it('maps the container types an iPhone actually produces', () => {
    expect(mimeFromFilename('IMG_0421.MOV')).toBe('video/quicktime');
    expect(mimeFromFilename('clip.mp4')).toBe('video/mp4');
    expect(mimeFromFilename('take1.webm')).toBe('video/webm');
    expect(mimeFromFilename('no-extension')).toBeUndefined();
  });

  it('recovers the index key from a media path', () => {
    expect(fingerprintFromPath('media/000002eeec3e2b5bc776254630b0')).toBe('000002eeec3e2b5bc776254630b0');
  });

  it('gives a bound object URL a typed blob', async () => {
    const media = new MemoryMediaStore();
    const record = await media.put(makeFile('IMG_0421.MOV', 'footage', 'video/quicktime'));
    const project = rebindSource(makeProject(), 'src_take1', record.path, record.fingerprint);

    const bound = await bindProjectMedia(project, media);
    const blob = await (await fetch(bound.urls.get('src_take1')!)).blob();
    // An untyped blob here is exactly what Safari refuses to play.
    expect(blob.type).toBe('video/quicktime');
  });
});

/**
 * Both caches, one test body.
 *
 * The memory double exists so the analysis pipeline is testable outside a browser, which
 * only works if it behaves like the real store. A double that is more forgiving than the
 * thing it stands in for hides exactly the bugs it was meant to surface — this project has
 * already been bitten once by that, when the memory media store handed back the original
 * File and so never reproduced the MIME failure a phone hit on the first import.
 */
describe.each([
  ['memory', () => new MemoryDerivedCache()],
  ['indexeddb', () => new IdbDerivedCache(new IdbConnection(new IDBFactory()))],
])('%s derived cache', (_name, make) => {
  it('returns null for a key it has never seen', async () => {
    expect(await make().get('signals:nope')).toBeNull();
  });

  it('round-trips a value', async () => {
    const cache = make();
    await cache.put('signals:abc:1', { onsets: [{ t: 1_000_000, strength: 0.5 }] });
    expect(await cache.get('signals:abc:1')).toEqual({ onsets: [{ t: 1_000_000, strength: 0.5 }] });
  });

  it('overwrites rather than accumulating', async () => {
    const cache = make();
    await cache.put('k', { v: 1 });
    await cache.put('k', { v: 2 });
    expect(await cache.get('k')).toEqual({ v: 2 });
  });

  it('forgets a deleted key', async () => {
    const cache = make();
    await cache.put('k', { v: 1 });
    await cache.delete('k');
    expect(await cache.get('k')).toBeNull();
  });
});

describe.each([
  ['memory', () => ({ settings: new MemorySettingsStore(), projects: null })],
  [
    'indexeddb',
    () => {
      const connection = new IdbConnection(new IDBFactory());
      return { settings: new IdbSettingsStore(connection), projects: new IdbProjectStore(connection) };
    },
  ],
])('%s settings store', (_name, make) => {
  it('round-trips a value and forgets a deleted one', async () => {
    const { settings } = make();
    expect(await settings.get('anthropic')).toBeNull();

    await settings.set('anthropic', { apiKey: 'sk-test', model: 'claude-opus-5' });
    expect(await settings.get('anthropic')).toEqual({ apiKey: 'sk-test', model: 'claude-opus-5' });

    await settings.delete('anthropic');
    expect(await settings.get('anthropic')).toBeNull();
  });

  it('does not collide with the app’s own bookkeeping', async () => {
    // Settings and `lastOpened` share one object store. A setting named `lastOpened`
    // must not reopen a project that does not exist, or clear the one that does.
    const { settings, projects } = make();
    if (!projects) return;

    await projects.setLastOpened('prj_real');
    await settings.set('lastOpened', 'not a project id');

    expect(await projects.getLastOpened()).toBe('prj_real');
    expect(await settings.get('lastOpened')).toBe('not a project id');
  });
});

/**
 * Which paths own the index entry under them, and which merely borrow the fingerprint.
 *
 * A recording and its proxy share a fingerprint — that is how one finds the other — so the
 * last segment of a path is not a licence to act on the record beneath it. Deleting a
 * half-written proxy took the recording's filename and MIME type with it, and a recording
 * with no recorded type comes back untyped, which Safari refuses to decode. That was
 * "sometimes it shows the video and sometimes it doesn't".
 *
 * The same rule keeps `openWrite` off a recording, because a writable truncates what it
 * opens and the two paths are one shadowed variable apart.
 */
describe('what a media path owns', () => {
  it('claims the index entry only for the recording itself', () => {
    expect(indexKeyFor('media/0000abcd')).toBe('0000abcd');
  });

  it('claims nothing for anything derived from it', () => {
    expect(indexKeyFor('proxy/0000abcd')).toBe(null);
    expect(indexKeyFor('proxy/0000abcd.ok')).toBe(null);
  });

  it('claims nothing for a path it does not recognise', () => {
    expect(indexKeyFor('0000abcd')).toBe(null);
    expect(indexKeyFor('media/nested/0000abcd')).toBe(null);
    expect(indexKeyFor('')).toBe(null);
  });
});
