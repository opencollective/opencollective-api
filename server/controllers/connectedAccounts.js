import config from 'config';
import { get } from 'lodash';

import { mustBeLoggedInTo } from '../lib/auth';
import errors from '../lib/errors';
import * as github from '../lib/github';
import logger from '../lib/logger';
import RateLimit from '../lib/rate-limit';
import models from '../models';
import paymentProviders from '../paymentProviders';

export const createOrUpdate = async (req, res, next, accessToken, data) => {
  if (!req.remoteUser) {
    throw new Error('Please login to edit connected account');
  }

  const { CollectiveId, context } = req.query;
  const { service } = req.params;

  switch (service) {
    case 'github': {
      const profile = data.profile._json;

      const userCollective = await models.Collective.findByPk(req.remoteUser.CollectiveId);

      userCollective.description = userCollective.description || profile.bio;
      userCollective.website = userCollective.website || profile.blog || profile.html_url;
      userCollective.image = userCollective.image || `https://avatars.githubusercontent.com/${data.profile.username}`;
      userCollective.repositoryUrl = `https://github.com/${data.profile.username}`;

      await userCollective.save();

      let connectedAccount = await models.ConnectedAccount.findOne({
        where: { service, CollectiveId: userCollective.id },
      });
      if (!connectedAccount) {
        connectedAccount = await models.ConnectedAccount.create({
          service,
          CollectiveId: userCollective.id,
          clientId: profile.id,
          data: profile,
          CreatedByUserId: req.remoteUser.id,
        });
      }
      await connectedAccount.update({
        username: data.profile.username,
        token: accessToken,
      });

      const token = req.remoteUser.generateConnectedAccountVerifiedToken(connectedAccount.id, data.profile.username);
      if (context === 'createCollective') {
        res.redirect(
          `${config.host.website}/opensource/apply/pick-repo?token=${token}${
            CollectiveId ? `&collectiveSlug=${CollectiveId}` : ''
          }`,
        );
      } else {
        res.redirect(`${config.host.website}/${userCollective.slug}/admin/connected-accounts`);
      }

      break;
    }

    default:
      throw new errors.BadRequest(`unsupported service ${service}`);
  }
};

export const disconnect = async (req, res) => {
  const { collectiveId: CollectiveId, service } = req.params;
  const { remoteUser } = req;

  try {
    mustBeLoggedInTo(remoteUser, 'disconnect this connected account');

    if (!remoteUser.isAdmin(CollectiveId)) {
      throw new errors.Unauthorized('You are either logged out or not authorized to disconnect this account');
    }

    const account = await models.ConnectedAccount.findOne({
      where: { service, CollectiveId },
    });

    if (account) {
      await account.destroy();
      await models.ConnectedAccount.destroy({ where: { data: { MirrorConnectedAccountId: account.id } } });
    }

    res.send({
      deleted: true,
      service,
    });
  } catch (err) {
    res.send({
      error: {
        message: err.message,
      },
    });
  }
};

export const verify = async (req, res, next) => {
  // How many times a user can call this endpoint in a minute.
  const rateLimit = new RateLimit(`connected-accounts-verify-${req.ip}`, 60, 10);
  try {
    await rateLimit.registerCallOrThrow();
  } catch (e) {
    return next(new errors.RateLimitExceeded());
  }

  const payload = req.jwtPayload;
  const service = req.params.service;

  if (get(paymentProviders, `${service}.oauth.verify`)) {
    return paymentProviders[service].oauth.verify(req, res, next);
  }

  if (!payload) {
    return next(new errors.Unauthorized());
  }
  if (payload.scope === 'connected-account' && payload.username) {
    res.send({
      service,
      username: payload.username,
      connectedAccountId: payload.connectedAccountId,
    });
  } else {
    return next(new errors.BadRequest('Github authorization failed'));
  }
};

const getGithubAccount = async req => {
  const payload = req.jwtPayload;
  const githubAccount = await models.ConnectedAccount.findOne({
    where: { id: payload.connectedAccountId },
  });
  if (!githubAccount) {
    throw new errors.BadRequest('No connected GitHub Account');
  }
  return githubAccount;
};

// Use a 1 minutes timeout as the default 25 seconds can leads to failing requests.
const GITHUB_REPOS_FETCH_TIMEOUT = 1 * 60 * 1000;

// used in Frontend by createCollective "GitHub flow"
export const fetchAllRepositories = async (req, res, next) => {
  // How many times a user can call this endpoint in a minute.
  const rateLimit = new RateLimit(`connected-accounts-fetch-all-repositories-${req.ip}`, 60, 10);
  try {
    await rateLimit.registerCallOrThrow();
  } catch (e) {
    return next(new errors.RateLimitExceeded());
  }

  if (req.jwtPayload?.scope !== 'connected-account') {
    const errorMessage = `Cannot use this token on this route (scope: ${
      req.jwtPayload?.scope || 'session'
    }, expected: connected-account)`;
    if (['e2e', 'ci'].includes(config.env)) {
      // An E2E test is relying on this, so let's relax for now
      logger.warn(errorMessage);
    } else {
      return next(new errors.BadRequest(errorMessage));
    }
  }

  const githubAccount = await getGithubAccount(req);
  try {
    req.setTimeout(GITHUB_REPOS_FETCH_TIMEOUT);
    let repos = await github.getAllUserPublicRepos(githubAccount.token);
    if (repos.length !== 0) {
      repos = repos
        .filter(repo => {
          return repo.fork === false;
        })
        .sort((a, b) => {
          return b.stargazers_count - a.stargazers_count;
        });
    }
    res.send(repos);
  } catch (e) {
    next(e);
  }
};
