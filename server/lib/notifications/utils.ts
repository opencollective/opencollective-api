import * as cheerio from 'cheerio';

import { optsSanitizeUpdateHtml, parseServiceLink, sanitizeHTML } from '../sanitize-html';
import { reportErrorToSentry } from '../sentry';
import { constructYouTubeWatchUrl, YOUTUBE_VIDEO_ID_PATTERN } from '../url-utils';

const constructPreviewImageURL = (service: string, id: string) => {
  if (service === 'youtube' && YOUTUBE_VIDEO_ID_PATTERN.test(id)) {
    return `https://img.youtube.com/vi/${id}/0.jpg`;
  } else if (service === 'anchorFm') {
    return `https://opencollective.com/static/images/anchor-fm-logo.png`;
  } else {
    return null;
  }
};

const constructPreviewLinkHref = (service: string, id: string, iframeSrc: string) => {
  if (service === 'youtube' && YOUTUBE_VIDEO_ID_PATTERN.test(id)) {
    return constructYouTubeWatchUrl(id);
  } else if (service === 'anchorFm') {
    return iframeSrc;
  } else {
    return null;
  }
};

/**
 * Replaces supported video iframes with a linked preview image.
 *
 * sanitize-html can rename tags but cannot emit nested markup (e.g. `<a><img></a>`)
 * from transformTags, so we rewrite the DOM first and sanitize the result afterward.
 */
const replaceIframesWithPreviewLinks = (html: string): string => {
  // Fragment mode: do not wrap the HTML in `<html><body>`.
  const $ = cheerio.load(html, null, false);

  $('iframe').each((_, element) => {
    const iframe = $(element);
    const src = iframe.attr('src');

    if (!src) {
      iframe.remove();
      return;
    }

    const { service, id } = parseServiceLink(src);
    const imgSrc = constructPreviewImageURL(service, id);
    const linkHref = constructPreviewLinkHref(service, id, src);

    if (!imgSrc || !linkHref) {
      iframe.remove();
      return;
    }

    const link = $('<a></a>').attr({ href: linkHref });
    link.append($('<img></img>').attr({ src: imgSrc, alt: `${service} content` }));
    iframe.replaceWith(link);
  });

  return $.html() ?? '';
};

/**
 * Prepares update HTML for notification emails: supported video embeds become
 * clickable preview images, since iframes are not reliably rendered in email clients.
 */
export const replaceVideosByImagePreviews = (html: string) => {
  try {
    html = replaceIframesWithPreviewLinks(html);
  } catch (error) {
    // Do not block the email from being sent if there is an error replacing the videos by image previews.
    // Sanitization will simply strip all iframes in this case.
    reportErrorToSentry(error);
  }

  return sanitizeHTML(html, {
    ...optsSanitizeUpdateHtml,
    transformTags: {
      ...optsSanitizeUpdateHtml.transformTags,
      // Cheerio already converted supported iframes; strip any that remain.
      iframe: () => '',
    },
  });
};
