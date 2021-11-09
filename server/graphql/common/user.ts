import config from 'config';
import { pick } from 'lodash';

import roles from '../../constants/roles';
import cache, { fetchCollectiveId } from '../../lib/cache';
import emailLib from '../../lib/email';
import logger from '../../lib/logger';
import models, { Op, sequelize } from '../../models';
import { ValidationFailed } from '../errors';

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
  userData: { firstName: string; lastName: string; legalName: string; email: string; newsletterOptIn: boolean },
  { organizationData, sendSignInLink, throwIfExists, redirect, websiteUrl, creationRequest }: CreateUserOptions,
): Promise<{ user: typeof models.User; organization?: typeof models.Collective }> => {
  return sequelize.transaction(async transaction => {
    let user = await models.User.findOne({ where: { email: userData.email.toLowerCase() } }, { transaction });

    if (throwIfExists && user) {
      throw new ValidationFailed('It looks like that email already exists, please sign in instead');
    } else if (!user) {
      // Create user
      user = await models.User.createUserWithCollective(userData, transaction);
      user = await user.update({ data: { creationRequest } }, { transaction });
    }

    let organization;
    // Create organization
    if (organizationData) {
      const organizationParams = {
        type: 'ORGANIZATION',
        CreatedByUserId: user.id,
        ...pick(organizationData, [
          'name',
          'legalName',
          'slug',
          'description',
          'website',
          'twitterHandle',
          'githubHandle',
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
      emailLib.send('user.new.token', user.email, { loginLink }, { sendEvenIfNotProduction: true });
    }

    return { user, organization };
  });
};

export const hasSeenLatestChangelogEntry = async (user: typeof models.User): Promise<boolean> => {
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
