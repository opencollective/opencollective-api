import { expect } from 'chai';
import config from 'config';

import { replaceVideosByImagePreviews } from '../../../../server/lib/notifications/utils';

describe('server/lib/notifications/utils', () => {
  describe('replaceVideosByImagePreviews', () => {
    describe('YouTube', () => {
      it('converts watch URLs', () => {
        expect(
          replaceVideosByImagePreviews(
            '<iframe src="https://www.youtube.com/watch?v=JODaYjDyjyQ&ab_channel=NPRMusic"></iframe>',
          ),
        ).to.equal(
          '<a href="https://www.youtube.com/watch?v=JODaYjDyjyQ"><img src="https://img.youtube.com/vi/JODaYjDyjyQ/0.jpg" alt="youtube content" /></a>',
        );
      });

      it('converts youtube-nocookie embed URLs with showinfo query param', () => {
        expect(
          replaceVideosByImagePreviews(
            '<iframe src="https://www.youtube-nocookie.com/embed/KLeHuFu_zIM?showinfo=0" width="100%" height="394"></iframe>',
          ),
        ).to.equal(
          '<a href="https://www.youtube.com/watch?v=KLeHuFu_zIM"><img src="https://img.youtube.com/vi/KLeHuFu_zIM/0.jpg" alt="youtube content" /></a>',
        );
      });

      it('converts youtube.com embed URLs', () => {
        expect(
          replaceVideosByImagePreviews('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>'),
        ).to.equal(
          '<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"><img src="https://img.youtube.com/vi/dQw4w9WgXcQ/0.jpg" alt="youtube content" /></a>',
        );
      });

      it('converts youtu.be URLs', () => {
        expect(replaceVideosByImagePreviews('<iframe src="https://youtu.be/dQw4w9WgXcQ"></iframe>')).to.equal(
          '<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"><img src="https://img.youtube.com/vi/dQw4w9WgXcQ/0.jpg" alt="youtube content" /></a>',
        );
      });

      it('converts shorts URLs', () => {
        expect(
          replaceVideosByImagePreviews('<iframe src="https://www.youtube.com/shorts/dQw4w9WgXcQ"></iframe>'),
        ).to.equal(
          '<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"><img src="https://img.youtube.com/vi/dQw4w9WgXcQ/0.jpg" alt="youtube content" /></a>',
        );
      });

      it('converts embed iframes inside a figure', () => {
        expect(
          replaceVideosByImagePreviews(
            '<div>Content before<br /><figure data-trix-content-type="--embed-iframe-video"><iframe src="https://www.youtube-nocookie.com/embed/KLeHuFu_zIM?showinfo=0" width="100%" height="394"></iframe><figcaption></figcaption></figure><br />Content after</div>',
          ),
        ).to.equal(
          '<div>Content before<br /><figure data-trix-content-type="--embed-iframe-video"><a href="https://www.youtube.com/watch?v=KLeHuFu_zIM"><img src="https://img.youtube.com/vi/KLeHuFu_zIM/0.jpg" alt="youtube content" /></a><figcaption></figcaption></figure><br />Content after</div>',
        );
      });

      it('strips iframes with invalid video IDs', () => {
        expect(
          replaceVideosByImagePreviews('<iframe src="https://www.youtube.com/watch?v=tooshort"></iframe>'),
        ).to.equal('');
        expect(
          replaceVideosByImagePreviews('<iframe src="https://www.youtube.com/embed/not-valid-id"></iframe>'),
        ).to.equal('');
      });

      it('strips iframes with malformed YouTube URLs', () => {
        expect(replaceVideosByImagePreviews('<iframe src="not-a-url"></iframe>')).to.equal('');
        expect(replaceVideosByImagePreviews('<iframe src="https://www.vimeo.com/video/123456"></iframe>')).to.equal('');
      });
    });

    describe('Anchor.fm', () => {
      it('converts embed URLs with an episode', () => {
        expect(
          replaceVideosByImagePreviews('<iframe src="https://anchor.fm/my-podcast/embed/episodes/ep123"></iframe>'),
        ).to.equal(
          '<a href="https://anchor.fm/my-podcast/embed/episodes/ep123"><img src="https://opencollective.com/static/images/anchor-fm-logo.png" alt="anchorFm content" /></a>',
        );
      });

      it('converts embed URLs without an episode', () => {
        expect(replaceVideosByImagePreviews('<iframe src="https://anchor.fm/my-podcast/embed"></iframe>')).to.equal(
          '<a href="https://anchor.fm/my-podcast/embed"><img src="https://opencollective.com/static/images/anchor-fm-logo.png" alt="anchorFm content" /></a>',
        );
      });

      it('converts podcast URLs without an explicit embed path', () => {
        expect(replaceVideosByImagePreviews('<iframe src="https://anchor.fm/my-podcast"></iframe>')).to.equal(
          '<a href="https://anchor.fm/my-podcast"><img src="https://opencollective.com/static/images/anchor-fm-logo.png" alt="anchorFm content" /></a>',
        );
      });

      it('accepts www.anchor.fm', () => {
        expect(
          replaceVideosByImagePreviews('<iframe src="https://www.anchor.fm/my-podcast/embed/episodes/ep123"></iframe>'),
        ).to.equal(
          '<a href="https://www.anchor.fm/my-podcast/embed/episodes/ep123"><img src="https://opencollective.com/static/images/anchor-fm-logo.png" alt="anchorFm content" /></a>',
        );
      });

      it('rejects non-anchor.fm hostnames even when the path looks valid', () => {
        expect(
          replaceVideosByImagePreviews('<iframe src="https://evil.com/my-podcast/embed/episodes/ep123"></iframe>'),
        ).to.equal('');
      });

      it('rejects anchor.fm URLs with invalid paths', () => {
        expect(replaceVideosByImagePreviews('<iframe src="https://anchor.fm/"></iframe>')).to.equal('');
        expect(replaceVideosByImagePreviews('<iframe src="https://anchor.fm/podcast/foo/bar"></iframe>')).to.equal('');
      });
    });

    describe('unsupported or invalid iframes', () => {
      it('strips iframes without a src attribute', () => {
        expect(replaceVideosByImagePreviews('<iframe width="100%" height="394"></iframe>')).to.equal('');
      });

      it('strips Vimeo iframes', () => {
        expect(replaceVideosByImagePreviews('<iframe src="https://player.vimeo.com/video/123456"></iframe>')).to.equal(
          '',
        );
      });

      it('strips iframes with malicious src values', () => {
        expect(
          replaceVideosByImagePreviews('<iframe src="https://www.youtube.com/watch?v=X<script>xxx</script>"></iframe>'),
        ).to.equal('');
        expect(
          replaceVideosByImagePreviews('<iframe src="https://www.youtube.com/watch?v=xxx<script></script>"></iframe>'),
        ).to.equal('');
        expect(
          replaceVideosByImagePreviews('<iframe src="https://www.test.com/watch?v=xxxxxxxxxxx"></iframe>'),
        ).to.equal('');
      });
    });

    describe('HTML structure', () => {
      it('preserves surrounding HTML when converting a single iframe', () => {
        expect(
          replaceVideosByImagePreviews(
            '<div>Testing valid html content for notification email<iframe src="https://www.youtube.com/watch?v=JODaYjDyjyQ&ab_channel=NPRMusic"></iframe></div>',
          ),
        ).to.equal(
          '<div>Testing valid html content for notification email<a href="https://www.youtube.com/watch?v=JODaYjDyjyQ"><img src="https://img.youtube.com/vi/JODaYjDyjyQ/0.jpg" alt="youtube content" /></a></div>',
        );
      });

      it('leaves non-iframe HTML unchanged', () => {
        expect(replaceVideosByImagePreviews('<div>Testing valid html content for notification email</div>')).to.equal(
          '<div>Testing valid html content for notification email</div>',
        );
      });

      it('converts multiple iframes in the same document', () => {
        expect(
          replaceVideosByImagePreviews(
            '<iframe src="https://www.youtube.com/watch?v=JODaYjDyjyQ"></iframe><p>and</p><iframe src="https://anchor.fm/my-podcast/embed"></iframe>',
          ),
        ).to.equal(
          '<a href="https://www.youtube.com/watch?v=JODaYjDyjyQ"><img src="https://img.youtube.com/vi/JODaYjDyjyQ/0.jpg" alt="youtube content" /></a><p>and</p><a href="https://anchor.fm/my-podcast/embed"><img src="https://opencollective.com/static/images/anchor-fm-logo.png" alt="anchorFm content" /></a>',
        );
      });

      it('strips unsupported iframes but converts supported ones in mixed content', () => {
        expect(
          replaceVideosByImagePreviews(
            '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe><p>middle</p><iframe src="https://player.vimeo.com/video/123456"></iframe>',
          ),
        ).to.equal(
          '<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"><img src="https://img.youtube.com/vi/dQw4w9WgXcQ/0.jpg" alt="youtube content" /></a><p>middle</p>',
        );
      });

      it('does not let forged preview-link markers bypass link redirect policy', () => {
        const maliciousUrl = 'https://malicious-domain.com/phishing';
        expect(
          replaceVideosByImagePreviews(`<a href="${maliciousUrl}" data-video-preview-link="true">Click me</a>`),
        ).to.equal(`<a href="${config.host.website}/redirect?url=${encodeURIComponent(maliciousUrl)}">Click me</a>`);
      });
    });
  });
});
