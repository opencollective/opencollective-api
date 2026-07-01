import sanitizeHtml from 'sanitize-html';

import { optsSanitizeUpdateHtml, parseServiceLink } from '../sanitize-html';
import { YOUTUBE_VIDEO_ID_PATTERN } from '../url-utils';

const constructPreviewImageURL = (service: string, id: string) => {
  if (service === 'youtube' && YOUTUBE_VIDEO_ID_PATTERN.test(id)) {
    return `https://img.youtube.com/vi/${id}/0.jpg`;
  } else if (service === 'anchorFm') {
    return `https://opencollective.com/static/images/anchor-fm-logo.png`;
  } else {
    return null;
  }
};

export const replaceVideosByImagePreviews = (html: string) => {
  const sanitizerOptions = {
    ...optsSanitizeUpdateHtml,
    transformTags: {
      ...optsSanitizeUpdateHtml.transformTags,
      iframe: (tagName, attribs) => {
        if (!attribs.src) {
          return '';
        }
        const { service, id } = parseServiceLink(attribs.src);
        const imgSrc = constructPreviewImageURL(service, id);
        if (imgSrc) {
          return {
            tagName: 'img',
            attribs: {
              src: imgSrc,
              alt: `${service} content`,
            },
          };
        } else {
          return '';
        }
      },
    },
  };
  return sanitizeHtml(html, sanitizerOptions);
};
