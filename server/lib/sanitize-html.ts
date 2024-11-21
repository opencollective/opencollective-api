import config from 'config';
import { truncate, uniq } from 'lodash';
import prependHttp from 'prepend-http';
import LibSanitize from 'sanitize-html';

import { isValidUploadedImage } from './images';

interface AllowedContentType {
  /** Allows titles  supported by RichTextEditor (`h3` only) */
  titles?: boolean;
  /** Allow h1/h2. This option should not be used in places where we embed content as it can mess up with our layout */
  mainTitles?: boolean;
  /** Includes bold, italic, strong and strike */
  basicTextFormatting?: boolean;
  /** Includes multiline rich text formatting like lists or code blocks */
  multilineTextFormatting?: boolean;
  /** Allow <a href="..."/> */
  links?: boolean;
  /** Allow images */
  images?: boolean;
  /* Same as images but only allows images from our own services */
  imagesInternal?: boolean;
  /** Allow video iframes from trusted providers */
  videoIframes?: boolean;
  /** Allow tables */
  tables?: boolean;
}

interface SanitizeOptions {
  allowedTags: string[];
  allowedAttributes: Record<string, unknown>;
  allowedIframeHostnames: string[];
  transformTags: Record<string, unknown>;
}

export const buildSanitizerOptions = (allowedContent: AllowedContentType = {}): SanitizeOptions => {
  // Nothing allowed by default
  const allowedTags = [];
  const allowedAttributes = {};
  const allowedIframeHostnames = [];
  const transformTags = {
    a: function (_, attribs) {
      return {
        tagName: 'a',
        attribs: {
          ...attribs,
          href: formatLinkHref(attribs.href),
          rel: 'noopener noreferrer nofollow',
        },
      };
    },
  };

  // Titles
  if (allowedContent.mainTitles) {
    allowedTags.push('h1', 'h2', 'h3');
  } else if (allowedContent.titles) {
    allowedTags.push('h3');
    transformTags['h1'] = 'h3';
    transformTags['h2'] = 'h3';
  }

  // Multiline text formatting
  if (allowedContent.basicTextFormatting) {
    allowedTags.push('b', 'i', 'strong', 'em', 'strike', 'del');
  }

  // Basic text formatting
  if (allowedContent.multilineTextFormatting) {
    allowedTags.push('p', 'ul', 'ol', 'nl', 'li', 'blockquote', 'code', 'pre', 'br', 'div');
  }

  // Images
  if (allowedContent.images || allowedContent.imagesInternal) {
    allowedTags.push('img', 'figure', 'figcaption');
    allowedAttributes['img'] = ['src', 'alt', 'title'];
    if (allowedContent.imagesInternal) {
      transformTags['img'] = function (tagName, attribs) {
        if (isValidUploadedImage(attribs.src, { ignoreInNonProductionEnv: false })) {
          return { tagName, attribs };
        } else {
          return { tagName: 'INVALID_TAG', text: 'Invalid image' }; // Will be stripped by other rules (invalid tag name)
        }
      };
    }
  }

  // Links
  if (allowedContent.links) {
    allowedTags.push('a');
    allowedAttributes['a'] = ['href', 'name', 'target'];
  }

  // Tables
  if (allowedContent.tables) {
    allowedTags.push('table', 'thead', 'caption', 'tbody', 'tr', 'th', 'td');
  }

  // IFrames
  if (allowedContent.videoIframes) {
    allowedTags.push('iframe', 'figure');
    allowedIframeHostnames.push('www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com', 'anchor.fm');
    allowedAttributes['figure'] = ['data-trix-content-type'];
    allowedAttributes['iframe'] = [
      'src',
      'allowfullscreen',
      'frameborder',
      'autoplay',
      'width',
      'height',
      {
        name: 'allow',
        multiple: true,
        values: ['autoplay', 'encrypted-media', 'gyroscope'],
      },
    ];
  }

  return {
    allowedTags: uniq(allowedTags),
    allowedAttributes,
    allowedIframeHostnames,
    transformTags,
  };
};

/** Default options to strip everything */
const optsStripAll = buildSanitizerOptions();
const optsSanitizeSummary = buildSanitizerOptions({ links: true, basicTextFormatting: true });

/**
 * Options preset to pass to `sanitizeHTML` that match the RichTextEditor "simplified" mode.
 */
export const optsSanitizeHtmlForSimplified: SanitizeOptions = buildSanitizerOptions({
  basicTextFormatting: true,
  multilineTextFormatting: true,
  links: true,
});

/**
 * Sanitize the given input to strip the HTML content.
 *
 * This function is a specialization of the one provided by `sanitize-html` with
 * smart defaults to match our use cases. It works as a whitelist, so by default all
 * tags will be stripped out.
 */
export function sanitizeHTML(content: string, options: SanitizeOptions = optsStripAll): string {
  return LibSanitize(content, options);
}

/**
 * Will remove all HTML content from the string.
 */
export const stripHTML = (content: string): string => sanitizeHTML(content, optsStripAll);

/**
 * A safer version of `stripHTML` that returns an empty string if the input contains invalid HTML.
 */
export const stripHTMLOrEmpty = (content: string): string => {
  try {
    return sanitizeHTML(content, optsStripAll);
  } catch {
    return '';
  }
};

/**
 * An helper to generate a summary for an HTML content. A summary is defined as a single
 * line content truncated to a max length, with tags like code blocks removed. It still
 * allows the use of bold, italic and other single-line format options.
 */
export const generateSummaryForHTML = (content: string, maxLength = 255): string => {
  if (!content) {
    return null;
  }

  const cleanStr = content
    .replaceAll(/(<br\/?>)|(\n)/g, ' ') // Replace all new lines by separators
    .replaceAll(/<\/p>/g, '</p> ') // Add a space after each paragraph to mark the separation
    .replaceAll(/<\/h3>/g, '</h3> · '); // Separate titles from then rest with a midpoint;

  // Sanitize: `<li><strong> Test with   spaces </strong></li>` ==> `<strong> Test with   spaces </strong>`
  const sanitized = sanitizeHTML(cleanStr, optsSanitizeSummary);

  // Trim: `<strong> Test with   spaces </strong>` ==> <strong>Test with spaces</strong>
  const trimmed = sanitized.replaceAll('\n', ' ').replaceAll(/\s+/g, ' ').trim();

  const isTruncated = trimmed.length > maxLength;

  let cutLength = maxLength;
  let summary = trimmed;

  while (summary.length > maxLength) {
    // Truncate
    summary = truncate(summary, { length: cutLength, omission: '' });

    // Second sanitize pass: an additional precaution in case someones finds a way to play with the trimmed version
    summary = sanitizeHTML(summary, optsSanitizeSummary);

    cutLength--;
  }

  // Check to see if the second sanitization cuts a html tag in the middle
  if (isTruncated) {
    return `${summary.trim()}...`;
  } else {
    return summary;
  }
};

const formatLinkHref = (url: string): string => {
  if (!url) {
    return '';
  }

  const baseUrl = prependHttp(url);
  if (isTrustedLinkUrl(baseUrl)) {
    return baseUrl;
  } else {
    return `${config.host.website}/redirect?url=${encodeURIComponent(baseUrl)}`;
  }
};

const isTrustedLinkUrl = (url: string): boolean => {
  let parsedUrl = null;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (!['http:', 'https:', 'ftp:', 'mailto:'].includes(parsedUrl.protocol)) {
    throw new Error(`Invalid link protocol: ${parsedUrl.protocol}`);
  }

  const rootDomain = parsedUrl.host.replace(/^www\./, '');
  const trustedDomains = [
    new RegExp(`^(.+\\.)?${config.host.website.replace(/^https?:\/\//, '')}$`),
    /^(.+\.)?opencollective.com$/,
    /^(.+\.)?oscollective.org$/,
    /^(.+\.)?github.com$/,
    /^(.+\.)?meetup.com$/,
    /^(.+\.)?twitter.com$/,
    /^(.+\.)?wikipedia.com$/,
  ];

  return (
    trustedDomains.some(regex => rootDomain.match(regex)) ||
    isValidUploadedImage(url, { ignoreInNonProductionEnv: false })
  );
};
