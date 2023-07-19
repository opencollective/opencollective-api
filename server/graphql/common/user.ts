import config from 'config';
import { pick } from 'lodash-es';

import { activities } from '../../constants/index.js';
import { types } from '../../constants/collectives.js';
import roles from '../../constants/roles.js';
import cache, { fetchCollectiveId } from '../../lib/cache/index.js';
import emailLib from '../../lib/email.js';
import logger from '../../lib/logger.js';
import models, { Collective, Op, sequelize } from '../../models/index.js';
import User from '../../models/User.js';
import { ValidationFailed } from '../errors.js';

type CreateUserOptions = {
  organizationData?: {
    name: string;
    slug: string;
    website?: string;
    twitterHandle?: string;
    githubHandle?: string;
  };
  sendSignInLink?: boolean;
  throwIfExists?: boolean;
  redirect?: string;
  websiteUrl?: string;
  creationRequest?: {
    ip: string;
    userAgent: string;
  };
};

export const createUser = (
  userData: {
    name?: string;
    legalName?: string;
    email: string;
    newsletterOptIn: boolean;
    location: Record<string, unknown>;
  },
  { organizationData, sendSignInLink, throwIfExists, redirect, websiteUrl, creationRequest }: CreateUserOptions,
): Promise<{ user: User; organization?: Collective }> => {
  return sequelize.transaction(async transaction => {
    let user = await models.User.findOne({ where: { email: userData.email.toLowerCase() }, transaction });

    if (throwIfExists && user) {
      throw new ValidationFailed(
        'It looks like that email already exists, please sign in instead',
        'EMAIL_ALREADY_EXISTS',
      );
    } else if (!user) {
      // Create user
      user = await models.User.createUserWithCollective(userData, transaction);
      user = await user.update({ data: { creationRequest } }, { transaction });
    }

    let organization;
    // Create organization
    if (organizationData) {
      const organizationParams = {
        type: types.ORGANIZATION,
        CreatedByUserId: user.id,
        ...pick(organizationData, [
          'name',
          'legalName',
          'slug',
          'description',
          'website',
          'twitterHandle',
          'githubHandle',
          'repositoryUrl',
        ]),
      };
      organization = await models.Collective.create(organizationParams, { transaction });
      await organization.addUserWithRole(user, roles.ADMIN, { CreatedByUserId: user.id }, {}, transaction);
    }

    // Sent signIn link
    if (sendSignInLink) {
      const loginLink = user.generateLoginLink(redirect, websiteUrl);
      if (config.env === 'development') {
        logger.info(`Login Link: ${loginLink}`);
      }
      await emailLib.send(activities.USER_NEW_TOKEN, user.email, { loginLink }, { sendEvenIfNotProduction: true });
      await models.Activity.create(
        {
          type: activities.USER_NEW_TOKEN,
          UserId: user.id,
          CollectiveId: user.CollectiveId,
          FromCollectiveId: user.CollectiveId,
          data: { notify: false },
        },
        { transaction },
      );
    }
    return { user, organization };
  });
};

export const hasSeenLatestChangelogEntry = async (user: User): Promise<boolean> => {
  const cacheKey = 'latest_changelog_publish_date';
  let latestChangelogUpdatePublishDate = await cache.get(cacheKey);
  // Make sure we don't show the changelog notifications for newly confirmed users
  const userChangelogViewDate = user.changelogViewDate || user.confirmedAt || user.createdAt;
  if (latestChangelogUpdatePublishDate) {
    return userChangelogViewDate >= new Date(latestChangelogUpdatePublishDate);
  } else {
    const collectiveId = await fetchCollectiveId('opencollective');
    const latestChangelogUpdate = await models.Update.findOne({
      where: {
        CollectiveId: collectiveId,
        publishedAt: { [Op.ne]: null },
        isChangelog: true,
      },
      order: [['publishedAt', 'DESC']],
    });

    latestChangelogUpdatePublishDate = latestChangelogUpdate?.publishedAt;
    if (!latestChangelogUpdatePublishDate) {
      return true;
    }
    // keep the latest change log publish date for a day in cache
    cache.set(cacheKey, latestChangelogUpdatePublishDate, 24 * 60 * 60);
  }
  return userChangelogViewDate >= latestChangelogUpdatePublishDate;
};
