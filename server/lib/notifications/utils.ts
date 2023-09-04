import sanitizeHtml from 'sanitize-html';

import { sanitizerOptions as updateSanitizerOptions } from '../../models/Update';

const constructPreviewImageURL = (service: string, id: string) => {
  if (service === 'youtube' && id.match('[a-zA-Z0-9_-]{11}')) {
    return `https://img.youtube.com/vi/${id}/0.jpg`;
  } else if (service === 'anchorFm') {
    return `https://opencollective.com/static/images/anchor-fm-logo.png`;
  } else {
    return null;
  }
};

const parseServiceLink = (videoLink: string) => {
  const regexps = {
    youtube: new RegExp(
      '(?:https?://)?(?:www\\.)?youtu(?:\\.be/|be(-nocookie)?\\.com/\\S*(?:watch|embed|shorts)(?:(?:(?=/[^&\\s?]+(?!\\S))/)|(?:\\S*v=|v/)))([^&\\s?]+)',
      'i',
    ),
    anchorFm: /^(http|https)?:\/\/(www\.)?anchor\.fm\/([^/]+)(\/embed)?(\/episodes\/)?([^/]+)?\/?$/,
  };
  for (const service in regexps) {
    videoLink = videoLink.replace('/?showinfo=0', '');
    const matches = regexps[service].exec(videoLink);
    if (matches) {
      if (service === 'anchorFm') {
        const podcastName = matches[3];
        const episodeId = matches[6];
        const podcastUrl = `${podcastName}/embed`;
        return { service, id: episodeId ? `${podcastUrl}/episodes/${episodeId}` : podcastUrl };
      } else {
        return { service, id: matches[matches.length - 1] };
      }
    }
  }
  return {};
};

export const replaceVideosByImagePreviews = (html: string) => {
  const sanitizerOptions = {
    ...updateSanitizerOptions,
    transformTags: {
      ...updateSanitizerOptions.transformTags,
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
