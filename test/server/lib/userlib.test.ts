import { expect } from 'chai';

import UserLib from '../../../server/lib/userlib';

describe('server/lib/userlib', () => {
  describe('getUsernameFromGithubURL', () => {
    it('should return the username if the URL is a github URL', () => {
      expect(UserLib.getUsernameFromGithubURL('https://avatars.githubusercontent.com/username')).to.equal('username');
      expect(UserLib.getUsernameFromGithubURL('https://avatars.githubusercontent.com/username/')).to.equal('username');
    });

    it('should return the username if the URL is a github URL with a path', () => {
      expect(UserLib.getUsernameFromGithubURL('https://avatars.githubusercontent.com/username/path')).to.equal(
        'username',
      );
    });

    it('should return the username if the URL is a github URL with a path and query params', () => {
      expect(
        UserLib.getUsernameFromGithubURL('https://avatars.githubusercontent.com/username/path?query=param'),
      ).to.equal('username');
    });

    it('should return null if the URL is not a github URL', () => {
      expect(UserLib.getUsernameFromGithubURL('https://avatars.githubusercontent.com')).to.be.null;
      expect(UserLib.getUsernameFromGithubURL('https://avatars.githubusercontent.com/')).to.be.null;
      expect(UserLib.getUsernameFromGithubURL('dfksopfkdsofkds')).to.be.null;
    });

    it('should not be fooled by exotic URLs', () => {
      expect(UserLib.getUsernameFromGithubURL('https://avatars.githubusercontent.com@randomdomain.com/avatar')).to.be
        .null;
    });
  });
});
