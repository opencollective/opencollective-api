import { expect } from 'chai';
import config from 'config';

import { getEditRecurringContributionsUrl, parseAnchorFmURL, parseYouTubeVideoId } from '../../../server/lib/url-utils';
import { fakeOrganization, fakeUser } from '../../test-helpers/fake-data';

describe('server/lib/url-utils', () => {
  describe('getEditRecurringContributionsUrl', () => {
    it('generates link for user', async () => {
      const user = await fakeUser();
      expect(getEditRecurringContributionsUrl(user.collective)).to.equal(
        `${config.host.website}/dashboard/${user.collective.slug}/outgoing-contributions?status=ACTIVE&status=ERROR&type=RECURRING`,
      );
    });

    it('generates link for organization', async () => {
      const org = await fakeOrganization();
      expect(getEditRecurringContributionsUrl(org)).to.equal(
        `${config.host.website}/dashboard/${org.slug}/outgoing-contributions?status=ACTIVE&status=ERROR&type=RECURRING`,
      );
    });
  });

  describe('parseYouTubeVideoId', () => {
    const videoId = 'dQw4w9WgXcQ';

    it('parses youtube.com watch URLs', () => {
      expect(parseYouTubeVideoId(`https://www.youtube.com/watch?v=${videoId}`)).to.equal(videoId);
      expect(parseYouTubeVideoId(`https://youtube.com/watch?v=${videoId}&t=10`)).to.equal(videoId);
    });

    it('parses youtu.be URLs', () => {
      expect(parseYouTubeVideoId(`https://youtu.be/${videoId}`)).to.equal(videoId);
      expect(parseYouTubeVideoId(`https://www.youtu.be/${videoId}?t=10`)).to.equal(videoId);
    });

    it('parses youtube embed and shorts URLs', () => {
      expect(parseYouTubeVideoId(`https://www.youtube.com/embed/${videoId}`)).to.equal(videoId);
      expect(parseYouTubeVideoId(`https://www.youtube-nocookie.com/embed/${videoId}`)).to.equal(videoId);
      expect(parseYouTubeVideoId(`https://www.youtube.com/shorts/${videoId}`)).to.equal(videoId);
    });

    it('strips a trailing showinfo=0 suffix before parsing', () => {
      expect(parseYouTubeVideoId(`https://www.youtube-nocookie.com/embed/${videoId}?showinfo=0`)).to.equal(videoId);
    });

    it('returns null for invalid or unsupported URLs', () => {
      expect(parseYouTubeVideoId('')).to.be.null;
      expect(parseYouTubeVideoId('not-a-url')).to.be.null;
      expect(parseYouTubeVideoId('https://player.vimeo.com/video/123456')).to.be.null;
      expect(parseYouTubeVideoId('https://www.youtube.com/watch')).to.be.null;
      expect(parseYouTubeVideoId('https://www.youtube.com/watch?v=too-short')).to.be.null;
      expect(parseYouTubeVideoId('https://www.youtube.com/watch?v=way-too-long-id')).to.be.null;
    });
  });

  describe('parseAnchorFmURL', () => {
    it('parses podcast URLs', () => {
      expect(parseAnchorFmURL('https://anchor.fm/my-podcast')).to.equal('my-podcast/embed');
      expect(parseAnchorFmURL('https://www.anchor.fm/my-podcast/embed')).to.equal('my-podcast/embed');
    });

    it('parses episode URLs', () => {
      expect(parseAnchorFmURL('https://anchor.fm/my-podcast/episodes/ep-abc123')).to.equal(
        'my-podcast/embed/episodes/ep-abc123',
      );
      expect(parseAnchorFmURL('https://anchor.fm/my-podcast/embed/episodes/ep-abc123')).to.equal(
        'my-podcast/embed/episodes/ep-abc123',
      );
    });

    it('returns null for invalid or unsupported URLs', () => {
      expect(parseAnchorFmURL('')).to.be.null;
      expect(parseAnchorFmURL('not-a-url')).to.be.null;
      expect(parseAnchorFmURL('https://open.spotify.com/show/abc123')).to.be.null;
      expect(parseAnchorFmURL('https://anchor.fm/')).to.be.null;
      expect(parseAnchorFmURL('https://anchor.fm/my-podcast/unknown/path')).to.be.null;
    });
  });
});
