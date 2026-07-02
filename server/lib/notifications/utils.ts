import * as cheerio from 'cheerio';
import { omit } from 'lodash';

import { optsSanitizeUpdateHtml, parseServiceLink, sanitizeHTML } from '../sanitize-html';
import { reportErrorToSentry } from '../sentry';
import { YOUTUBE_VIDEO_ID_PATTERN } from '../url-utils';

/**
 * Marker attribute for preview links built from iframe src values.
 * Stripped during sanitization; see replaceVideosByImagePreviews.
 */
const VIDEO_PREVIEW_LINK_ATTR = 'data-video-preview-link';

const constructPreviewImageURL = (service: string, id: string) => {
  if (service === 'youtube' && YOUTUBE_VIDEO_ID_PATTERN.test(id)) {
    return `https://img.youtube.com/vi/${id}/0.jpg`;
  } else if (service === 'anchorFm') {
    return `https://opencollective.com/static/images/anchor-fm-logo.png`;
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
const replaceIframesWithPreviewLinks = (html: string): { html: string; previewLinkHrefs: Set<string> } => {
  const previewLinkHrefs = new Set<string>();

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

    if (!imgSrc) {
      iframe.remove();
      return;
    }

    previewLinkHrefs.add(src);
    const link = $('<a></a>').attr({ href: src, [VIDEO_PREVIEW_LINK_ATTR]: 'true' });
    link.append($('<img></img>').attr({ src: imgSrc, alt: `${service} content` }));
    iframe.replaceWith(link);
  });

  return { html: $.html() ?? '', previewLinkHrefs };
};

/**
 * Prepares update HTML for notification emails: supported video embeds become
 * clickable preview images, since iframes are not reliably rendered in email clients.
 */
export const replaceVideosByImagePreviews = (html: string) => {
  let previewLinkHrefs = new Set<string>();

  try {
    ({ html, previewLinkHrefs } = replaceIframesWithPreviewLinks(html));
  } catch (error) {
    // Do not block the email from being sent if there is an error replacing the videos by image previews.
    // Sanitization will simply strip all iframes in this case.
    reportErrorToSentry(error);
  }

  const defaultATransform = optsSanitizeUpdateHtml.transformTags.a as (
    tagName: string,
    attribs: Record<string, string>,
  ) => { tagName: string; attribs: Record<string, string> };

  return sanitizeHTML(html, {
    ...optsSanitizeUpdateHtml,
    allowedAttributes: {
      ...optsSanitizeUpdateHtml.allowedAttributes,
      a: [...(optsSanitizeUpdateHtml.allowedAttributes['a'] as string[]), VIDEO_PREVIEW_LINK_ATTR],
    },
    transformTags: {
      ...optsSanitizeUpdateHtml.transformTags,
      // Cheerio already converted supported iframes; strip any that remain.
      iframe: () => '',
      a: (tagName, attribs) => {
        const linkAttribs = omit(attribs, [VIDEO_PREVIEW_LINK_ATTR]);

        // Only iframe-derived preview links skip formatLinkHref; user-supplied markers are ignored.
        if (attribs[VIDEO_PREVIEW_LINK_ATTR] === 'true' && previewLinkHrefs.has(linkAttribs.href)) {
          return {
            tagName: 'a',
            attribs: {
              ...linkAttribs,
              rel: 'noopener noreferrer nofollow',
            },
          };
        }

        // Preview links keep the original iframe src (e.g. youtu.be, youtube-nocookie.com).
        // Other links still go through formatLinkHref and may use /redirect.
        return defaultATransform(tagName, linkAttribs);
      },
    },
  });
};
