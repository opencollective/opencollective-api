import { expect } from 'chai';
import sinon from 'sinon';

import {
  countChangedChars,
  getSanitizedContent,
  main,
  parseCommaSeparatedInts,
} from '../../../scripts/updates/update-html';
import { YOUTUBE_IFRAME_REFERRER_POLICY } from '../../../server/lib/sanitize-html';
import { sequelize } from '../../../server/models';
import Update from '../../../server/models/Update';
import { fakeUpdate } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

const STALE_YOUTUBE_HTML =
  '<iframe src="https://www.youtube.com/embed/G2IWYXxO324" referrerpolicy="no-referrer" width="100%" height="394"></iframe>';

const setStaleHtml = async (update: Update, html: string, summary = 'stale summary') => {
  await sequelize.query(`UPDATE "Updates" SET html = :html, summary = :summary WHERE id = :id`, {
    replacements: { html, summary, id: update.id },
  });
  await update.reload();
};

describe('scripts/updates/update-html', () => {
  beforeEach(async () => {
    await resetTestDB();
  });

  describe('parseCommaSeparatedInts', () => {
    it('parses comma-separated ids', () => {
      expect(parseCommaSeparatedInts('1, 2,3')).to.eql([1, 2, 3]);
    });

    it('returns undefined for empty input', () => {
      expect(parseCommaSeparatedInts(undefined)).to.be.undefined;
      expect(parseCommaSeparatedInts('')).to.be.undefined;
    });

    it('throws for invalid ids', () => {
      expect(() => parseCommaSeparatedInts('1,foo')).to.throw('Invalid update id in list: 1,foo');
    });
  });

  describe('countChangedChars', () => {
    it('returns 0 for identical strings', () => {
      expect(countChangedChars('hello', 'hello')).to.eq(0);
    });

    it('counts differing characters', () => {
      expect(countChangedChars('abc', 'axc')).to.eq(1);
      expect(countChangedChars('abc', 'abcd')).to.eq(1);
    });
  });

  describe('getSanitizedContent', () => {
    it('fixes youtube iframe referrer policy', () => {
      const { html } = getSanitizedContent(STALE_YOUTUBE_HTML);

      expect(html).to.include(`referrerpolicy="${YOUTUBE_IFRAME_REFERRER_POLICY}"`);
      expect(html).not.to.include('referrerpolicy="no-referrer"');
    });
  });

  describe('main', () => {
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('does not save changes in dry run mode', async () => {
      const update = await fakeUpdate();
      await setStaleHtml(update, STALE_YOUTUBE_HTML);

      const consoleLogSpy = sandbox.spy(console, 'log');
      await main(['node', 'script.ts', '--updateId', update.id.toString()]);

      await update.reload();
      expect(update.html).to.include('referrerpolicy="no-referrer"');
      expect(consoleLogSpy.calledWithMatch(/html changed \d+ chars/)).to.be.true;
    });

    it('re-sanitizes html with --no-dry-run', async () => {
      const update = await fakeUpdate();
      await setStaleHtml(update, STALE_YOUTUBE_HTML);

      await main(['node', 'script.ts', '--updateId', update.id.toString(), '--no-dry-run']);

      await update.reload();
      expect(update.html).to.include(`referrerpolicy="${YOUTUBE_IFRAME_REFERRER_POLICY}"`);
      expect(update.html).not.to.include('referrerpolicy="no-referrer"');
    });

    it('scopes to --updateId', async () => {
      const targetedUpdate = await fakeUpdate();
      const otherUpdate = await fakeUpdate();
      await setStaleHtml(targetedUpdate, STALE_YOUTUBE_HTML);
      await setStaleHtml(otherUpdate, STALE_YOUTUBE_HTML);

      const consoleLogSpy = sandbox.spy(console, 'log');
      await main(['node', 'script.ts', '--updateId', targetedUpdate.id.toString(), '--no-dry-run']);

      await targetedUpdate.reload();
      await otherUpdate.reload();

      expect(targetedUpdate.html).to.include(`referrerpolicy="${YOUTUBE_IFRAME_REFERRER_POLICY}"`);
      expect(otherUpdate.html).to.include('referrerpolicy="no-referrer"');
      expect(consoleLogSpy.calledWithMatch(new RegExp(`Update #${targetedUpdate.id}:`))).to.be.true;
      expect(consoleLogSpy.calledWithMatch(new RegExp(`Update #${otherUpdate.id}:`))).to.be.false;
    });

    it('scopes to --contains', async () => {
      const matchingUpdate = await fakeUpdate();
      const otherUpdate = await fakeUpdate();
      const marker = 'UNIQUE_MARKER_FOR_UPDATE_HTML_SCRIPT';
      await setStaleHtml(matchingUpdate, `<p>${marker}</p>${STALE_YOUTUBE_HTML}`);
      await setStaleHtml(otherUpdate, STALE_YOUTUBE_HTML);

      const consoleLogSpy = sandbox.spy(console, 'log');
      await main([
        'node',
        'script.ts',
        '--contains',
        marker,
        '--updateId',
        `${matchingUpdate.id},${otherUpdate.id}`,
        '--no-dry-run',
      ]);

      await matchingUpdate.reload();
      await otherUpdate.reload();

      expect(matchingUpdate.html).to.include(`referrerpolicy="${YOUTUBE_IFRAME_REFERRER_POLICY}"`);
      expect(otherUpdate.html).to.include('referrerpolicy="no-referrer"');
      expect(consoleLogSpy.calledWithMatch(new RegExp(`Update #${matchingUpdate.id}:`))).to.be.true;
      expect(consoleLogSpy.calledWithMatch(new RegExp(`Update #${otherUpdate.id}:`))).to.be.false;
    });

    it('skips already sanitized updates', async () => {
      const update = await fakeUpdate({
        html: getSanitizedContent('<p><strong>Already clean</strong></p>').html,
      });

      const consoleLogSpy = sandbox.spy(console, 'log');
      await main(['node', 'script.ts', '--updateId', update.id.toString()]);

      expect(consoleLogSpy.calledWithMatch(/Update #/)).to.be.false;
    });

    it('prints a line diff with --verbose', async () => {
      const update = await fakeUpdate();
      await setStaleHtml(update, STALE_YOUTUBE_HTML);

      const consoleLogSpy = sandbox.spy(console, 'log');
      await main(['node', 'script.ts', '--updateId', update.id.toString(), '--verbose']);

      expect(consoleLogSpy.calledWithMatch(new RegExp(`Update #${update.id}`))).to.be.true;
      expect(consoleLogSpy.calledWith('HTML diff:')).to.be.true;
      expect(consoleLogSpy.calledWithMatch(/referrerpolicy/)).to.be.true;
    });

    it('limits the number of updates processed with --limit', async () => {
      const updates = await Promise.all([fakeUpdate(), fakeUpdate(), fakeUpdate()]);
      await Promise.all(updates.map(update => setStaleHtml(update, STALE_YOUTUBE_HTML)));

      const consoleLogSpy = sandbox.spy(console, 'log');
      await main(['node', 'script.ts', '--updateId', updates.map(update => update.id).join(','), '--limit', '2']);

      const processedLogs = consoleLogSpy.getCalls().filter(call => /Update #\d+:/.test(String(call.args[0])));
      expect(processedLogs).to.have.length(2);
    });
  });
});
