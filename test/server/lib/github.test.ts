import { expect } from 'chai';

import { getGithubHandleFromUrl, getGithubUrlFromHandle } from '../../../server/lib/github.js';

const VALID_GITHUB_PROFILES = {
  'https://github.com/opencollective': 'opencollective',
  'https://github.com/opencollective/repo': 'opencollective/repo',
  'https://github.com/opencollective666/repo666': 'opencollective666/repo666',
  'https://github.com/my-org/my-repo': 'my-org/my-repo',
  'https://github.com/my-org/my.repo': 'my-org/my.repo',
  'https://github.com/my-org/.my-repo': 'my-org/.my-repo',
  'https://github.com/my-org/my_repo': 'my-org/my_repo',
  'https://github.com/my_org/my-repo': 'my_org/my-repo',
};

const INVALID_GITHUB_URLS = ['https://example.com', 'https://github.com'];

const INVALID_GITHUB_HANDLES = [
  '²²²²',
  'ééééé',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  'https://example.com',
  'my.org', // Dots not allowed in usernames
  '-nope', // Cannot start with -
  'test/-nope', // Cannot start with -
];

describe('server/lib/github', () => {
  describe('getGithubHandleFromUrl', () => {
    it('should return the github handle from a url', () => {
      Object.entries(VALID_GITHUB_PROFILES).forEach(([url, handle]) => {
        const hasOrgInHandle = handle.includes('/');
        expect(getGithubHandleFromUrl(url)).to.eq(handle);
        expect(getGithubHandleFromUrl(`${url}/`)).to.eq(handle); // with trailing slash
        expect(getGithubHandleFromUrl(`   ${url}/   `)).to.eq(handle); // with trailing slash
        if (hasOrgInHandle) {
          expect(getGithubHandleFromUrl(`${url}/sub/path`)).to.eq(handle); // with sub path
        }
      });
    });

    it('should return null if the url is not a github url', () => {
      INVALID_GITHUB_URLS.forEach(url => {
        expect(getGithubHandleFromUrl(url)).to.eq(null);
      });
    });
  });

  describe('getGithubUrlFromHandle', () => {
    it('should return the github url from a handle', () => {
      Object.entries(VALID_GITHUB_PROFILES).forEach(([url, handle]) => {
        expect(getGithubUrlFromHandle(handle)).to.eq(url);
        expect(getGithubUrlFromHandle(`${handle}/`)).to.eq(url);
        expect(getGithubUrlFromHandle(`   ${handle}/    `)).to.eq(url);
        expect(getGithubUrlFromHandle(`@${handle}`)).to.eq(url);
        expect(getGithubUrlFromHandle(`@${handle}/`)).to.eq(url);
      });
    });

    it('should return the cleaned github url if input already is an URL', () => {
      Object.entries(VALID_GITHUB_PROFILES).forEach(([url]) => {
        expect(getGithubUrlFromHandle(url)).to.eq(url);
        expect(getGithubUrlFromHandle(`${url}/`)).to.eq(url); // with trailing slash
        expect(getGithubUrlFromHandle(`${url}/    `)).to.eq(url); // with trailing slash
      });
    });

    it('should return null if the handle is not a github handle nor a URL', () => {
      INVALID_GITHUB_URLS.forEach(url => {
        expect(getGithubUrlFromHandle(url)).to.eq(null);
      });

      INVALID_GITHUB_HANDLES.forEach(url => {
        expect(getGithubUrlFromHandle(url)).to.eq(null);
      });
    });
  });
});
