/* eslint-disable camelcase */
import { expect } from 'chai';
import config from 'config';
import httpMocks from 'node-mocks-http';
import { createSandbox } from 'sinon';

import { createOrUpdate, fetchAllRepositories, verify } from '../../../server/controllers/connectedAccounts';
import { sessionCache } from '../../../server/lib/cache';
import errors from '../../../server/lib/errors';
import * as github from '../../../server/lib/github';
import RateLimit from '../../../server/lib/rate-limit';
import models from '../../../server/models';
import { fakeConnectedAccount, fakeUser, randIPV4, randStr } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

const makeGithubOAuthData = (username: string) => ({
  profile: {
    username,
    _json: {
      id: 12345,
      bio: 'Open source enthusiast',
      blog: 'https://example.com',
      html_url: `https://github.com/${username}`,
    },
  },
});

describe('server/controllers/connectedAccounts', () => {
  const sandbox = createSandbox();

  beforeEach(async () => {
    await utils.resetTestDB();
    sessionCache.clear();
  });

  afterEach(() => sandbox.restore());

  describe('createOrUpdate', () => {
    const next = () => {};

    it('throws when user is not logged in', async () => {
      const req = httpMocks.createRequest({
        params: { service: 'github' },
        query: {},
      });
      const res = httpMocks.createResponse();

      await expect(createOrUpdate(req, res, next, 'access-token', makeGithubOAuthData('octocat'))).to.be.rejectedWith(
        'Please login to edit connected account',
      );
    });

    it('throws for unsupported services', async () => {
      const user = await fakeUser();
      const req = httpMocks.createRequest({
        params: { service: 'twitter' },
        query: {},
      });
      req.remoteUser = user;
      const res = httpMocks.createResponse();

      await expect(createOrUpdate(req, res, next, 'access-token', {})).to.be.rejectedWith(
        errors.BadRequest,
        'unsupported service twitter',
      );
    });

    it('creates a GitHub connected account and redirects to admin settings', async () => {
      const user = await fakeUser();
      const username = randStr('gh-user-');
      const accessToken = randStr('gh-token-');
      const req = httpMocks.createRequest({
        params: { service: 'github' },
        query: {},
      });
      req.remoteUser = user;
      const res = httpMocks.createResponse();
      res.redirect = sandbox.stub();

      await createOrUpdate(req, res, next, accessToken, makeGithubOAuthData(username));

      const connectedAccount = await models.ConnectedAccount.findOne({
        where: { service: 'github', CollectiveId: user.CollectiveId },
      });
      expect(connectedAccount).to.exist;
      expect(connectedAccount.username).to.equal(username);
      expect(connectedAccount.token).to.equal(accessToken);

      const userCollective = await models.Collective.findByPk(user.CollectiveId);
      expect(userCollective.repositoryUrl).to.equal(`https://github.com/${username}`);
      expect(userCollective.image).to.equal(`https://avatars.githubusercontent.com/${username}`);

      expect(res.redirect).to.have.been.calledOnceWith(
        `${config.host.website}/${userCollective.slug}/admin/connected-accounts`,
      );
    });

    it('updates an existing GitHub connected account', async () => {
      const user = await fakeUser();
      const username = randStr('gh-user-');
      const existingAccount = await fakeConnectedAccount({
        service: 'github',
        CollectiveId: user.CollectiveId,
        username: 'old-username',
        token: 'old-token',
      });
      const newToken = randStr('gh-token-');
      const req = httpMocks.createRequest({
        params: { service: 'github' },
        query: {},
      });
      req.remoteUser = user;
      const res = httpMocks.createResponse();
      res.redirect = sandbox.stub();

      await createOrUpdate(req, res, next, newToken, makeGithubOAuthData(username));

      const connectedAccounts = await models.ConnectedAccount.findAll({
        where: { service: 'github', CollectiveId: user.CollectiveId },
      });
      expect(connectedAccounts).to.have.lengthOf(1);
      await existingAccount.reload();
      expect(existingAccount.username).to.equal(username);
      expect(existingAccount.token).to.equal(newToken);
    });

    it('redirects to pick-repo when context is createCollective', async () => {
      const user = await fakeUser();
      const username = randStr('gh-user-');
      const collectiveSlug = randStr('collective-');
      const req = httpMocks.createRequest({
        params: { service: 'github' },
        query: { context: 'createCollective', CollectiveId: collectiveSlug },
      });
      req.remoteUser = user;
      const res = httpMocks.createResponse();
      res.redirect = sandbox.stub();

      await createOrUpdate(req, res, next, randStr('gh-token-'), makeGithubOAuthData(username));

      const connectedAccount = await models.ConnectedAccount.findOne({
        where: { service: 'github', CollectiveId: user.CollectiveId },
      });
      const expectedToken = user.generateConnectedAccountVerifiedToken(connectedAccount.id, username);

      expect(res.redirect).to.have.been.calledOnceWith(
        `${config.host.website}/opensource/apply/pick-repo?token=${expectedToken}&collectiveSlug=${collectiveSlug}`,
      );
    });
  });

  describe('verify', () => {
    it('calls next with Unauthorized when there is no JWT payload', async () => {
      const next = sandbox.stub();
      const req = httpMocks.createRequest({
        ip: randIPV4(),
        params: { service: 'github' },
      });
      const res = httpMocks.createResponse();

      await verify(req, res, next);

      expect(next).to.have.been.calledOnce;
      expect(next.firstCall.args[0]).to.be.instanceOf(errors.Unauthorized);
    });

    it('calls next with BadRequest when username is missing from the token', async () => {
      const next = sandbox.stub();
      const req = httpMocks.createRequest({
        ip: randIPV4(),
        params: { service: 'github' },
      });
      req.jwtPayload = { scope: 'connected-account', connectedAccountId: 1 } as any;
      const res = httpMocks.createResponse();

      await verify(req, res, next);

      expect(next).to.have.been.calledOnce;
      expect(next.firstCall.args[0]).to.be.instanceOf(errors.BadRequest);
      expect(next.firstCall.args[0].message).to.equal('Github authorization failed');
    });

    it('returns connected account details for a valid token', async () => {
      const next = sandbox.stub();
      const send = sandbox.stub();
      const req = httpMocks.createRequest({
        ip: randIPV4(),
        params: { service: 'github' },
      });
      req.jwtPayload = {
        scope: 'connected-account',
        username: 'octocat',
        connectedAccountId: 42,
      } as any;
      const res = { send };

      await verify(req, res, next);

      expect(next).to.not.have.been.called;
      expect(send).to.have.been.calledOnceWith({
        service: 'github',
        username: 'octocat',
        connectedAccountId: 42,
      });
    });

    it('calls next with RateLimitExceeded when rate limit is reached', async () => {
      sandbox.stub(RateLimit.prototype, 'registerCallOrThrow').rejects(new Error('Rate limit reached'));
      const next = sandbox.stub();
      const req = httpMocks.createRequest({
        ip: randIPV4(),
        params: { service: 'github' },
      });
      const res = httpMocks.createResponse();

      await verify(req, res, next);

      expect(next).to.have.been.calledOnce;
      expect(next.firstCall.args[0]).to.be.instanceOf(errors.RateLimitExceeded);
    });
  });

  describe('fetchAllRepositories', () => {
    it('calls next with BadRequest when token scope is not connected-account', async () => {
      const next = sandbox.stub();
      const req = httpMocks.createRequest({
        ip: randIPV4(),
        params: { service: 'github' },
      });
      req.jwtPayload = { scope: 'session' } as any;
      const res = httpMocks.createResponse();

      await fetchAllRepositories(req, res, next);

      expect(next).to.have.been.calledOnce;
      expect(next.firstCall.args[0]).to.be.instanceOf(errors.BadRequest);
      expect(next.firstCall.args[0].message).to.include('expected: connected-account');
    });

    it('throws BadRequest when connected account does not exist', async () => {
      const next = sandbox.stub();
      const req = httpMocks.createRequest({
        ip: randIPV4(),
        params: { service: 'github' },
      });
      req.jwtPayload = {
        scope: 'connected-account',
        connectedAccountId: 999999,
      } as any;
      const res = httpMocks.createResponse();

      await expect(fetchAllRepositories(req, res, next)).to.be.rejectedWith(
        errors.BadRequest,
        'No connected GitHub Account',
      );
    });

    it('returns public repos excluding forks, sorted by stars', async () => {
      const user = await fakeUser();
      const connectedAccount = await fakeConnectedAccount({
        service: 'github',
        CollectiveId: user.CollectiveId,
        token: randStr('gh-token-'),
      });
      sandbox.stub(github, 'getAllUserPublicRepos').resolves([
        { fork: true, stargazers_count: 100, name: 'forked-repo' },
        { fork: false, stargazers_count: 10, name: 'small-repo' },
        { fork: false, stargazers_count: 50, name: 'popular-repo' },
      ]);

      const next = sandbox.stub();
      const send = sandbox.stub();
      const req = httpMocks.createRequest({
        ip: randIPV4(),
        params: { service: 'github' },
      });
      req.jwtPayload = {
        scope: 'connected-account',
        connectedAccountId: connectedAccount.id,
      } as any;
      req.setTimeout = sandbox.stub();
      const res = { send };

      await fetchAllRepositories(req, res, next);

      expect(next).to.not.have.been.called;
      expect(send).to.have.been.calledOnceWith([
        { fork: false, stargazers_count: 50, name: 'popular-repo' },
        { fork: false, stargazers_count: 10, name: 'small-repo' },
      ]);
      expect(github.getAllUserPublicRepos).to.have.been.calledOnceWith(connectedAccount.token);
      expect(req.setTimeout).to.have.been.calledOnce;
    });

    it('forwards GitHub API errors to next', async () => {
      const user = await fakeUser();
      const connectedAccount = await fakeConnectedAccount({
        service: 'github',
        CollectiveId: user.CollectiveId,
        token: randStr('gh-token-'),
      });
      const githubError = new Error('GitHub API unavailable');
      sandbox.stub(github, 'getAllUserPublicRepos').rejects(githubError);

      const next = sandbox.stub();
      const req = httpMocks.createRequest({
        ip: randIPV4(),
        params: { service: 'github' },
      });
      req.jwtPayload = {
        scope: 'connected-account',
        connectedAccountId: connectedAccount.id,
      } as any;
      req.setTimeout = sandbox.stub();
      const res = httpMocks.createResponse();

      await fetchAllRepositories(req, res, next);

      expect(next).to.have.been.calledOnceWith(githubError);
    });
  });
});
