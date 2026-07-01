import config from 'config';
import isURL from 'validator/lib/isURL';

export const getEditRecurringContributionsUrl = collective => {
  return `${config.host.website}/dashboard/${collective.slug}/outgoing-contributions?status=ACTIVE&status=ERROR&type=RECURRING`;
};

export const getHostname = url => {
  return new URL(url).hostname.replace(/^www\./, '');
};

/**
 * Takes an URL like https://xxx.opencollective.com/test, returns 'opencollective.com'
 */
export const getRootDomain = (url: string): string => {
  return getHostname(url).split('.').slice(-2).join('.');
};

export const isValidRESTServiceURL = (url: string): boolean => {
  let parsedURL;
  try {
    parsedURL = new URL(url);
  } catch {
    return false;
  }

  return parsedURL.origin === config.host.rest;
};

export function isValidURL(url: string) {
  const isDevEnv =
    ['development', 'test', 'e2e', 'ci'].includes(config.env) ||
    process.env.E2E_TEST ||
    process.env.NODE_ENV !== 'production';
  return isURL(url, {
    // eslint-disable-next-line camelcase
    require_host: !isDevEnv,
    // eslint-disable-next-line camelcase
    require_tld: !isDevEnv,
  });
}

/**
 * Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * @license MIT
 * @author Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)
 * @see https://www.npmjs.com/package/prepend-http
 */
export function prependHttp(url: string, options: { https?: boolean } = {}) {
  if (typeof url !== 'string') {
    throw new TypeError(`Expected \`url\` to be of type \`string\`, got \`${typeof url}\``);
  }

  url = url.trim();

  options = {
    https: true,
    ...options,
  };

  if (/^\.*\/|^(?!localhost)\w+:/.test(url)) {
    return url;
  }

  return url.replace(/^(?!(?:\w+:)?\/\/)/, options.https ? 'https://' : 'http://');
}

export const YOUTUBE_VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

export const parseYouTubeVideoId = (videoLink: string): string | null => {
  try {
    const cleanLink = videoLink.replace(/\?showinfo=0$/, '');
    const url = new URL(cleanLink);
    const hostname = url.hostname.replace(/^www\./, '');

    if (hostname === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      return YOUTUBE_VIDEO_ID_PATTERN.test(id) ? id : null;
    }

    if (hostname === 'youtube.com' || hostname === 'youtube-nocookie.com') {
      if (url.pathname.startsWith('/embed/') || url.pathname.startsWith('/shorts/')) {
        const id = url.pathname.split('/')[2];
        return YOUTUBE_VIDEO_ID_PATTERN.test(id) ? id : null;
      }

      const id = url.searchParams.get('v');
      return id && YOUTUBE_VIDEO_ID_PATTERN.test(id) ? id : null;
    }
  } catch {
    return null;
  }

  return null;
};

const ANCHOR_FM_PATH_PATTERN = /^\/([^/]+)(?:\/embed)?(?:\/episodes\/([^/]+))?\/?$/;

export const parseAnchorFmURL = (videoLink: string): string | null => {
  try {
    const url = new URL(videoLink);
    const hostname = url.hostname.replace(/^www\./, '');

    if (hostname !== 'anchor.fm') {
      return null;
    }

    const matches = ANCHOR_FM_PATH_PATTERN.exec(url.pathname);
    if (!matches) {
      return null;
    }

    const podcastName = matches[1];
    const episodeId = matches[2];
    const podcastUrl = `${podcastName}/embed`;
    return episodeId ? `${podcastUrl}/episodes/${episodeId}` : podcastUrl;
  } catch {
    return null;
  }
};
