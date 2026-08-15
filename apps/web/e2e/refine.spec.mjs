import { readFileSync } from 'node:fs';
import { APP_URL, artifact, ensureClip, exportEdl, launch, makeReport, scrubTo } from './harness.mjs';

/**
 * The refinement pass against a model, with the API intercepted.
 *
 * Everything up to the network is real: the settings screen, the stored key, the Anthropic
 * SDK, the prompt builder, the op parser, the dry-run validator, the review screen. Only
 * the API itself is replaced — with a handler that records what the browser actually sent.
 *
 * That request body is the point. It is the only place to check the two claims the app
 * makes to the user: that the model is being told what the footage sounds like, and that
 * the footage itself never leaves the device. Both are assertions about bytes on the wire,
 * and neither can be made anywhere but here.
 */
const { browser, page, errors } = await launch({ device: 'iPhone 15 Pro' });
const { report, check, set, finish } = makeReport({});

const clip = await ensureClip(page);
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-expose-headers': '*',
};

const sent = [];
let reply = null;

// Stands in for api.anthropic.com. The preflight matters: the SDK sends `x-api-key` and
// `content-type`, which makes this a non-simple cross-origin request, and a handler that
// only answered POST would fail at the OPTIONS with an error the app never sees.
await page.route('https://api.anthropic.com/**', async (route) => {
  const request = route.request();
  if (request.method() === 'OPTIONS') {
    return route.fulfill({ status: 204, headers: CORS });
  }
  sent.push({ url: request.url(), headers: request.headers(), body: request.postDataJSON() });
  return route.fulfill({
    status: reply?.status ?? 200,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(reply?.body ?? {}),
  });
});

// --- Import, cut, freeze -----------------------------------------------------------
await page.goto(APP_URL);
await page.locator('text=Choose a video').waitFor();
await page.setInputFiles('input[type=file]', clip);
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });

await scrubTo(page, 0.42);
await page.locator('button[aria-label="Cut at playhead"]').click();
await page.waitForTimeout(300);

// Let the signals pass finish, so the prompt has something to say about the footage.
await page.waitForFunction(
  () => !document.querySelector('.meta')?.textContent?.includes('listening to the footage'),
  null,
  { timeout: 90_000 },
);

await page.locator('button:has-text("Done")').click();
await page.waitForTimeout(300);

// --- No key: the local heuristics, not an error ------------------------------------
await page.locator('button:has-text("Refine")').click();
await page.locator('.sheet').waitFor({ timeout: 10000 });
check('saysItWillUseTheHeuristics', await page.locator('.sheet-actions .primary').innerText(), 'Suggest edits');
await page.locator('.sheet-actions .primary').click();
await page.locator('.bubble').first().waitFor({ timeout: 10000 });
check('worksWithNoKeyConfigured', (await page.locator('.bubble').count()) > 0, true);
check('noApiCallWithoutAKey', sent.length, 0);

await page.locator('header .primary').click();
await page.locator('.review').waitFor({ timeout: 10000 });
check('saysWhoSuggestedIt', /built-in heuristics/.test(await page.locator('.sheet-count').innerText()), true);
await page.locator('.review-actions .ghost.danger').click(); // discard the pass
await page.waitForTimeout(400);
check('discardingClearsTheBubbles', await page.locator('.bubble').count(), 0);

// --- Configure a key -----------------------------------------------------------------
await page.locator('footer button[aria-label="Settings"]').click();
await page.locator('.settings').waitFor();
await page.locator('.field input[type=password]').fill('sk-ant-test-key');
await page.locator('.settings-actions .primary').click();
await page.locator('.timeline').waitFor({ timeout: 10000 });

const before = await exportEdl(page, 'refine-before.json');
const clips = before.timeline.tracks[0].clips.filter((c) => c.enabled);
check('twoClipsToRefine', clips.length, 2);

// The canned proposal references real clip ids, so the dry-run validator has to accept
// it — a plan full of invented ids would be filtered out and prove nothing.
reply = {
  status: 200,
  body: {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 2480, output_tokens: 512 },
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01',
        name: 'propose_edits',
        input: {
          summary: 'Tightened the first join and pushed in on the hit.',
          ops: [
            {
              op: 'trim',
              clipId: clips[0].id,
              sourceOut: clips[0].sourceOut - 400_000,
              rationale: 'ends on measured silence',
            },
            {
              op: 'setSpeed',
              clipId: clips[1].id,
              speed: 1.5,
              rationale: 'quiet and static for most of its length',
            },
            // Deliberately invalid: a clip id that does not exist. It must never reach
            // the review screen — a wasted review slot is the thing the dry run prevents.
            { op: 'remove', clipId: 'clp_notreal', rationale: 'should be filtered out' },
          ],
        },
      },
    ],
  },
};

// --- Refine, for real: the brief and the target are asked for here, per video --------
await page.locator('button:has-text("Refine")').click();
await page.locator('.sheet').waitFor({ timeout: 10000 });
await page.locator('.sheet textarea').fill('Punchy. Hold on the hits, cut the dead air.');
await page.locator('.sheet input[type=text]').fill('0:09');
await page.locator('.sheet-actions .primary').click();
await page.locator('.bubble').first().waitFor({ timeout: 30000 });

// Two calls, not one: the third op in the canned reply never applies, so the repair round
// fires. That is the loop working, not a bug — and the stub answers identically both
// times, which is exactly how a model that ignores "don't resend" behaves.
check('askedAgainAfterTheBadOp', sent.length, 2);
const request = sent[0];
set('endpoint', request.url);
check('postedToMessages', request.url, 'https://api.anthropic.com/v1/messages');
check('sentTheKey', request.headers['x-api-key'], 'sk-ant-test-key');
check('declaredBrowserAccess', request.headers['anthropic-dangerous-direct-browser-access'], 'true');

// --- What was actually sent ---------------------------------------------------------
const prompt = request.body.messages[0].content;
set('model', request.body.model);
set('promptChars', typeof prompt === 'string' ? prompt.length : -1);
check('askedForTheOpTool', request.body.tools[0].name, 'propose_edits');
check('adaptiveThinking', request.body.thinking, { type: 'adaptive' });

// The two claims the app makes to the user, checked on the wire.
check('promptCarriesTheSignals', /Signals measured from the footage/.test(prompt), true);
check('promptCarriesTheBrief', prompt.includes('Punchy. Hold on the hits'), true);
// The target is arithmetic, not atmosphere: the model is told the number, the current
// length, and the gap, because those are what let it check its own work.
check('promptCarriesTheTarget', /Target length: .*\(9000000us\)/.test(prompt), true);
check('promptSaysHowFarOver', /which is .* (over|under)/.test(prompt), true);
check(
  'noFootageLeftTheDevice',
  !/"type"\s*:\s*"(image|document)"/.test(JSON.stringify(request.body)) &&
    !/base64|data:video|data:image/.test(JSON.stringify(request.body)),
  true,
);
set('promptHead', prompt.slice(0, 200).replace(/\s+/g, ' '));

// --- What came back -----------------------------------------------------------------
await page.locator('header .primary').click();
await page.locator('.review').waitFor({ timeout: 10000 });
check('modelNamedInTheList', /claude-opus-5/.test(await page.locator('.sheet-count').innerText()), true);
// Three ops proposed, one of them invalid. Two survive.
check('invalidOpNeverReachedReview', await page.locator('.proposal').count(), 2);
const rationales = await page.locator('.proposal small').allInnerTexts();
set('rationales', rationales);
check('rationalesCameFromTheModel', rationales.some((r) => r.includes('measured silence')), true);
check('nothingPreAccepted', await page.locator('.proposal.accepted').count(), 0);

await page.screenshot({ path: artifact('refine-review.png') });

// --- Accept one, and check what was recorded ----------------------------------------
await page.locator('.proposal').nth(0).locator('button:has-text("Keep")').click();
await page.locator('.proposal').nth(1).locator('button:has-text("Skip")').click();
await page.locator('.review-actions .primary').click();
await page.locator('.timeline').waitFor({ timeout: 10000 });
await page.waitForTimeout(600);

const after = await exportEdl(page, 'refine-after.json');
const revision = after.revisions.filter((r) => r.review).at(-1);
set('revisionModel', revision?.model);
check('revisionCreditsTheModel', revision?.model, 'claude-opus-5');
check('appliedOnlyWhatWasAccepted', revision?.ops.length, 1);
check('rejectionSurvived', revision?.review.verdicts.filter((v) => !v.accepted).length, 1);

// The key must not be anywhere in an artifact the user might share.
check('keyNotInTheEdl', JSON.stringify(after).includes('sk-ant-test-key'), false);

const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('footer button:has-text("Log")').click(),
]);
await download.saveAs(artifact('refine-log.jsonl'));
const log = readFileSync(artifact('refine-log.jsonl'), 'utf8');
check('keyNotInTheLog', log.includes('sk-ant-test-key'), false);
check('briefNotStoredVerbatimInLog', log.includes('Punchy. Hold on the hits'), false);

const events = log.split('\n').filter(Boolean).map((line) => JSON.parse(line));
const requested = events.find((event) => event.type === 'llm.request');
const planned = events.filter((event) => event.type === 'llm.plan').at(-1);
set('llmRequest', requested?.payload);
set('llmPlan', planned?.payload);
check('loggedTheRequest', requested?.payload?.model, 'claude-opus-5');
check('loggedTheBriefAsADigest', /^[0-9a-f]{12}$/.test(requested?.payload?.brief ?? ''), true);
check('loggedTheCost', planned?.payload?.inputTokens, 2480);
check('loggedTheDroppedOp', planned?.payload?.rejected, 1);

// --- A rejected key says so, and says where to fix it --------------------------------
reply = { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'bad key' } } };
await page.locator('button:has-text("Refine")').click();
await page.locator('.sheet').waitFor({ timeout: 10000 });
await page.locator('.sheet-actions .primary').click();
await page.locator('.error').waitFor({ timeout: 30000 });
check('badKeyExplainsTheFix', await page.locator('.error').innerText(), 'That API key was rejected. Check it in Settings.');

const code = finish(errors.filter((error) => !error.includes('favicon') && !error.includes('401')));
await browser.close();
process.exit(code);
