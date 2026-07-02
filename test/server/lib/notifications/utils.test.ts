import { expect } from 'chai';

import { replaceVideosByImagePreviews } from '../../../../server/lib/notifications/utils';

const youtubePreview = (videoId: string) => `https://img.youtube.com/vi/${videoId}/0.jpg`;
const anchorPreview = 'https://opencollective.com/static/images/anchor-fm-logo.png';

const iframe = (src: string, attrs = '') => `<iframe src="${src}"${attrs ? ` ${attrs}` : ''}></iframe>`;

const expectYoutubePreview = (html: string, videoId: string) => {
  expect(replaceVideosByImagePreviews(html)).to.equal(`<img src="${youtubePreview(videoId)}" alt="youtube content" />`);
};

const expectAnchorPreview = (html: string) => {
  expect(replaceVideosByImagePreviews(html)).to.equal(`<img src="${anchorPreview}" alt="anchorFm content" />`);
};

const expectIframeStripped = (html: string, expectedHtml: string) => {
  expect(replaceVideosByImagePreviews(html)).to.equal(expectedHtml);
};

describe('server/lib/notifications/utils', () => {
  describe('replaceVideosByImagePreviews', () => {
    describe('YouTube', () => {
      it('converts watch URLs', () => {
        expectYoutubePreview(iframe('https://www.youtube.com/watch?v=JODaYjDyjyQ&ab_channel=NPRMusic'), 'JODaYjDyjyQ');
      });

      it('converts youtube-nocookie embed URLs with showinfo query param', () => {
        expectYoutubePreview(
          iframe('https://www.youtube-nocookie.com/embed/KLeHuFu_zIM?showinfo=0', 'width="100%" height="394"'),
          'KLeHuFu_zIM',
        );
      });

      it('converts youtube.com embed URLs', () => {
        expectYoutubePreview(iframe('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
      });

      it('converts youtu.be URLs', () => {
        expectYoutubePreview(iframe('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
      });

      it('converts shorts URLs', () => {
        expectYoutubePreview(iframe('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
      });

      it('converts embed iframes inside a figure', () => {
        const html =
          '<div>Content before<br /><figure data-trix-content-type="--embed-iframe-video"><iframe src="https://www.youtube-nocookie.com/embed/KLeHuFu_zIM?showinfo=0" width="100%" height="394"></iframe><figcaption></figcaption></figure><br />Content after</div>';
        expect(replaceVideosByImagePreviews(html)).to.equal(
          `<div>Content before<br /><figure data-trix-content-type="--embed-iframe-video"><img src="${youtubePreview('KLeHuFu_zIM')}" alt="youtube content" /><figcaption></figcaption></figure><br />Content after</div>`,
        );
      });

      it('strips iframes with invalid video IDs', () => {
        expectIframeStripped(iframe('https://www.youtube.com/watch?v=tooshort'), '');
        expectIframeStripped(iframe('https://www.youtube.com/embed/not-valid-id'), '');
      });

      it('strips iframes with malformed YouTube URLs', () => {
        expectIframeStripped(iframe('not-a-url'), '');
        expectIframeStripped(iframe('https://www.vimeo.com/video/123456'), '');
      });
    });

    describe('Anchor.fm', () => {
      it('converts embed URLs with an episode', () => {
        expectAnchorPreview(iframe('https://anchor.fm/my-podcast/embed/episodes/ep123'));
      });

      it('converts embed URLs without an episode', () => {
        expectAnchorPreview(iframe('https://anchor.fm/my-podcast/embed'));
      });

      it('converts podcast URLs without an explicit embed path', () => {
        expectAnchorPreview(iframe('https://anchor.fm/my-podcast'));
      });

      it('accepts www.anchor.fm', () => {
        expectAnchorPreview(iframe('https://www.anchor.fm/my-podcast/embed/episodes/ep123'));
      });

      it('rejects non-anchor.fm hostnames even when the path looks valid', () => {
        expectIframeStripped(iframe('https://evil.com/my-podcast/embed/episodes/ep123'), '');
      });

      it('rejects anchor.fm URLs with invalid paths', () => {
        expectIframeStripped(iframe('https://anchor.fm/'), '');
        expectIframeStripped(iframe('https://anchor.fm/podcast/foo/bar'), '');
      });
    });

    describe('unsupported or invalid iframes', () => {
      it('strips iframes without a src attribute', () => {
        expectIframeStripped('<iframe width="100%" height="394"></iframe>', '');
      });

      it('strips Vimeo iframes', () => {
        expectIframeStripped(iframe('https://player.vimeo.com/video/123456'), '');
      });

      it('strips iframes with malicious src values', () => {
        const maliciousSources = [
          'https://www.youtube.com/watch?v=X<script>xxx</script>',
          'https://www.youtube.com/watch?v=xxx<script></script>',
          'https://www.test.com/watch?v=xxxxxxxxxxx',
        ];

        for (const src of maliciousSources) {
          const result = replaceVideosByImagePreviews(iframe(src));
          expect(result).to.not.contain('<script>');
          expect(result).to.not.contain('<iframe');
          expect(result).to.equal('');
        }
      });
    });

    describe('HTML structure', () => {
      it('preserves surrounding HTML when converting a single iframe', () => {
        const html =
          '<div>Testing valid html content for notification email<iframe src="https://www.youtube.com/watch?v=JODaYjDyjyQ&ab_channel=NPRMusic"></iframe></div>';
        expect(replaceVideosByImagePreviews(html)).to.equal(
          `<div>Testing valid html content for notification email<img src="${youtubePreview('JODaYjDyjyQ')}" alt="youtube content" /></div>`,
        );
      });

      it('leaves non-iframe HTML unchanged', () => {
        const html = '<div>Testing valid html content for notification email</div>';
        expect(replaceVideosByImagePreviews(html)).to.equal(html);
      });

      it('converts multiple iframes in the same document', () => {
        const html = `${iframe('https://www.youtube.com/watch?v=JODaYjDyjyQ')}<p>and</p>${iframe('https://anchor.fm/my-podcast/embed')}`;
        expect(replaceVideosByImagePreviews(html)).to.equal(
          `<img src="${youtubePreview('JODaYjDyjyQ')}" alt="youtube content" /><p>and</p><img src="${anchorPreview}" alt="anchorFm content" />`,
        );
      });

      it('strips unsupported iframes but converts supported ones in mixed content', () => {
        const html = `${iframe('https://www.youtube.com/embed/dQw4w9WgXcQ')}<p>middle</p>${iframe('https://player.vimeo.com/video/123456')}`;
        expect(replaceVideosByImagePreviews(html)).to.equal(
          `<img src="${youtubePreview('dQw4w9WgXcQ')}" alt="youtube content" /><p>middle</p>`,
        );
      });
    });
  });
});
