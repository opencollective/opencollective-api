import config from 'config';
import slugify from 'limax';
import { cloneDeep, get, isEqual, isNil, isUndefined, omit, pick, truncate, uniqWith } from 'lodash';
import { Op, QueryTypes } from 'sequelize';
import { v4 as uuid } from 'uuid';

import activities from '../../../constants/activities';
import { CollectiveType } from '../../../constants/collectives';
import roles from '../../../constants/roles';
import { purgeCacheForCollective } from '../../../lib/cache';
import * as collectivelib from '../../../lib/collectivelib';
import * as github from '../../../lib/github';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../../lib/rate-limit';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import { defaultHostCollective } from '../../../lib/utils';
import models, { sequelize } from '../../../models';
import { SocialLinkType } from '../../../models/SocialLink';
import { NotFound, RateLimitExceeded, Unauthorized, ValidationFailed } from '../../errors';
import { VENDOR_INFO_FIELDS } from '../../v2/mutation/VendorMutations';
import { CollectiveInputType } from '../inputTypes';

const DEFAULT_COLLECTIVE_SETTINGS = {
  features: { conversations: true },
};

export async function createCollective(_, args, req) {
  const { remoteUser } = req;
  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to create a collective');
  }

  if (!args.collective.name) {
    throw new ValidationFailed('collective.name required');
  }

  const rateLimitKey = `collective_create_${remoteUser.id}`;
  const rateLimit = new RateLimit(rateLimitKey, 60, ONE_HOUR_IN_SECONDS, true);
  if (!(await rateLimit.registerCall())) {
    throw new RateLimitExceeded();
  }

  // TODO: enable me when Cypress helpers are migrated to v2
  // if (args.collective.type === types.COLLECTIVE) {
  //   throw new ValidationFailed('This mutation should not be used to create Collectives, use GraphQL v2.');
  // }

  let hostCollective, parentCollective, collective;

  const collectiveData = {
    ...args.collective,
    CreatedByUserId: req.remoteUser.id,
    settings: { ...DEFAULT_COLLECTIVE_SETTINGS, ...args.collective.settings },
  };

  // Set private instructions
  if (args.collective.privateInstructions) {
    collectiveData.data = {
      privateInstructions: args.collective.privateInstructions,
    };
  }

  collectiveData.isActive = false;
  if (args.collective.ParentCollectiveId) {
    parentCollective = await req.loaders.Collective.byId.load(args.collective.ParentCollectiveId);
    if (!parentCollective) {
      return Promise.reject(new Error(`Parent collective with id ${args.collective.ParentCollectiveId} not found`));
    } else if (!req.remoteUser.hasRole([roles.ADMIN, roles.MEMBER], parentCollective.id)) {
      throw new Unauthorized(
        `You must be logged in as a member of the ${parentCollective.slug} collective to create an event`,
      );
    }

    if (args.collective.type !== CollectiveType.VENDOR) {
      // The currency of the new created collective if not specified should be the one of its direct parent or the host (in this order)
      collectiveData.currency = collectiveData.currency || parentCollective.currency;
      collectiveData.HostCollectiveId = parentCollective.HostCollectiveId;

      if (collectiveData.type === CollectiveType.EVENT) {
        collectiveData.platformFeePercent = parentCollective.platformFeePercent;
      }
    }
  }

  if (collectiveData.HostCollectiveId) {
    hostCollective = await req.loaders.Collective.byId.load(collectiveData.HostCollectiveId);
    if (!hostCollective) {
      return Promise.reject(new Error(`Host collective with id ${args.collective.HostCollectiveId} not found`));
    } else if (req.remoteUser.hasRole([roles.ADMIN], hostCollective.id)) {
      collectiveData.isActive = true;
    } else if (parentCollective && parentCollective.HostCollectiveId === hostCollective.id) {
      // We can approve the collective directly if same host and parent collective is already approved
      collectiveData.isActive = parentCollective.isActive;
      collectiveData.approvedAt = parentCollective.isActive ? new Date() : null;
    } else if (!get(hostCollective, 'settings.apply')) {
      throw new Unauthorized('This host does not accept applications for new collectives');
    }

    collectiveData.currency = collectiveData.currency || hostCollective.currency;
    collectiveData.hostFeePercent = hostCollective.hostFeePercent;
  }

  // To ensure uniqueness of the slug, if the type of collective is EVENT
  // we force the slug to be of the form of `${slug}-${randomIdentifier}`
  if (collectiveData.type === 'EVENT') {
    const slug = slugify(args.collective.slug || args.collective.name);
    collectiveData.slug = `${slug}-${uuid().substr(0, 8)}`;
  } else if (collectiveData.type === CollectiveType.VENDOR) {
    const slug = slugify(args.collective.slug || args.collective.name);
    collectiveData.slug = `${args.collective.ParentCollectiveId}-${slug}-${uuid().substr(0, 8)}`;
    collectiveData.data = {
      ...collectiveData.data,
      vendorInfo: pick(args.collective.vendorInfo, VENDOR_INFO_FIELDS),
    };
  }

  try {
    collective = await models.Collective.create(omit(collectiveData, ['HostCollectiveId']));
  } catch (e) {
    let msg;
    switch (e.name) {
      case 'SequelizeUniqueConstraintError':
        msg = `The slug ${e.fields.slug.replace(
          /\-[0-9]+ev$/,
          '',
        )} is already taken. Please use another slug for your ${collectiveData.type.toLowerCase()}.`;
        break;
      default:
        msg = e.message;
        break;
    }
    throw new Error(msg);
  }

  const promises = [];

  if (collectiveData.tiers) {
    promises.push(collective.editTiers(collectiveData.tiers));
  }

  if (collectiveData.HostCollectiveId) {
    promises.push(collective.addHost(hostCollective, req.remoteUser));
  }

  // We add the admins of the parent collective as admins
  if (collectiveData.type === CollectiveType.EVENT) {
    // Nothing needed, ADMINS of the Parent are Admins of the Event and that's it
  } else if (collectiveData.members) {
    promises.push(
      collective.editMembers(collectiveData.members, {
        CreatedByUserId: req.remoteUser.id,
        remoteUserCollectiveId: req.remoteUser.CollectiveId,
      }),
    );
  } else {
    promises.push(collective.addUserWithRole(req.remoteUser, roles.ADMIN, { CreatedByUserId: req.remoteUser.id }));
  }

  if (args.collective.location) {
    promises.push(collective.setLocation(args.collective.location));
  }

  await Promise.all(promises);

  // Purge cache for parent collective (for events) and hosts
  if (parentCollective) {
    purgeCacheForCollective(parentCollective.slug);
  }
  if (hostCollective) {
    purgeCacheForCollective(hostCollective.slug);
  }

  // Inherit fees from parent collective after setting its host (events)
  if (parentCollective) {
    await collective.update({
      hostFeePercent: parentCollective.hostFeePercent,
      data: { ...collective.data, useCustomHostFee: Boolean(parentCollective.data?.useCustomHostFee) },
    });
  }

  return collective;
}

export async function createCollectiveFromGithub(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to create a collective');
  }

  if (!args.collective.name) {
    throw new ValidationFailed('collective.name required');
  }

  if (config.env === 'production') {
    throw new Error('This mutation is not allowed in production');
  }

  let collective;
  const user = req.remoteUser;

  if (args.collective.githubHandle && !github.githubHandleRegex.test(args.collective.githubHandle)) {
    throw new ValidationFailed('githubHandle must be a valid github handle');
  }

  const githubHandle = github.getGithubHandleFromUrl(args.collective.repositoryUrl) || args.collective.githubHandle;
  const collectiveData = {
    ...args.collective,
    settings: { ...DEFAULT_COLLECTIVE_SETTINGS, ...args.collective.settings },
  };

  // For e2e testing, we enable testuser+(admin|member|host)@opencollective.com to create collective without github validation
  if (config.env !== 'production' && user.email.match(/.*test.*@opencollective.com$/)) {
    const existingCollective = models.Collective.findOne({
      where: { slug: collectiveData.slug.toLowerCase() },
    });
    if (existingCollective) {
      collectiveData.slug = `${collectiveData.slug}-${Math.floor(Math.random() * 1000 + 1)}`;
    }
    collectiveData.currency = 'USD';
    collectiveData.CreatedByUserId = user.id;
    collectiveData.LastEditedByUserId = user.id;
    collective = await models.Collective.create(collectiveData);
    const host = await req.loaders.Collective.byId.load(defaultHostCollective('opensource').CollectiveId);
    const promises = [
      collective.addUserWithRole(user, roles.ADMIN),
      collective.addHost(host, user, { shouldAutomaticallyApprove: true }),
      collective.update({ isActive: true, approvedAt: new Date() }),
    ];

    await Promise.all(promises);
    return collective;
  }

  const existingCollective = await models.Collective.findOne({
    where: { slug: collectiveData.slug.toLowerCase() },
  });

  if (existingCollective) {
    throw new Error(
      `The slug ${
        collectiveData.slug
      } is already taken. Please use another slug for your ${collectiveData.type.toLowerCase()}.`,
    );
  }

  const githubAccount = await models.ConnectedAccount.findOne({
    where: { CollectiveId: req.remoteUser.CollectiveId, service: 'github' },
  });
  if (!githubAccount) {
    throw new Error('You must have a connected GitHub Account to create a collective with GitHub.');
  }

  try {
    await github.checkGithubAdmin(githubHandle, githubAccount.token);
    await github.checkGithubStars(githubHandle, githubAccount.token);
    if (githubHandle.includes('/')) {
      const repo = await github.getRepo(githubHandle, githubAccount.token);
      collectiveData.tags = repo.topics || [];
      collectiveData.tags.push('open source');
      collectiveData.description = truncate(repo.description, { length: 255 });
      collectiveData.longDescription = repo.description;
      collectiveData.settings.githubRepo = githubHandle;
    } else {
      collectiveData.settings.githubOrg = githubHandle;
    }
  } catch (error) {
    throw new ValidationFailed(error.message);
  }

  collectiveData.currency = 'USD';
  collectiveData.CreatedByUserId = user.id;
  collectiveData.LastEditedByUserId = user.id;

  try {
    collective = await models.Collective.create(collectiveData);
  } catch (err) {
    throw new Error(err.message);
  }

  const host = await req.loaders.Collective.byId.load(defaultHostCollective('opensource').CollectiveId);
  const promises = [
    collective.addUserWithRole(user, roles.ADMIN),
    collective.addHost(host, user, { skipCollectiveApplyActivity: true }),
    collective.update({ isActive: true, approvedAt: new Date() }),
  ];

  await Promise.all(promises);

  models.Activity.create({
    type: activities.COLLECTIVE_CREATED_GITHUB,
    UserId: user.id,
    UserTokenId: req.userToken?.id,
    CollectiveId: collective.id,
    FromCollectiveId: collective.id,
    HostCollectiveId: collective.approvedAt ? collective.HostCollectiveId : null,
    data: {
      collective: collective.info,
      host: host.info,
      user: user.info,
    },
  });

  return collective;
}

function getCollectiveDataDiff(originalCollective, modifiedCollective) {
  const collectiveInputTypeFields = Object.keys(CollectiveInputType.getFields());
  const originalCollectiveData = pick(originalCollective, collectiveInputTypeFields);
  const modifiedCollectiveData = pick(modifiedCollective, collectiveInputTypeFields);
  const differenceKeys = Object.keys(originalCollectiveData).filter(
    k => !isEqual(originalCollectiveData[k], modifiedCollectiveData[k]),
  );
  const previousData = pick(originalCollectiveData, differenceKeys);
  const newData = pick(modifiedCollectiveData, differenceKeys);
  return { previousData, newData };
}

export function editCollective(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to edit a collective');
  }

  if (!args.collective.id) {
    throw new ValidationFailed('collective.id required');
  }

  const newCollectiveData = {
    ...omit(args.collective, ['location', 'type', 'ParentCollectiveId', 'data', 'privateInstructions']),
    LastEditedByUserId: req.remoteUser.id,
  };

  if (args.collective.githubHandle && !github.githubHandleRegex.test(args.collective.githubHandle)) {
    throw new ValidationFailed('githubHandle must be a valid github handle');
  }

  let originalCollective, collective, parentCollective;

  return (
    req.loaders.Collective.byId
      .load(args.collective.id)
      .then(c => {
        if (!c) {
          throw new Error(`Collective with id ${args.collective.id} not found`);
        }
        originalCollective = cloneDeep(c);
        collective = c;
      })
      .then(() => {
        if (collective.ParentCollectiveId) {
          return req.loaders.Collective.byId.load(collective.ParentCollectiveId).then(pc => {
            if (!pc) {
              return Promise.reject(new Error(`Parent collective with id ${collective.ParentCollectiveId} not found`));
            }
            parentCollective = pc;
          });
        }
      })
      // Check permissions
      .then(() => {
        return req.remoteUser.isAdminOfCollective(collective);
      })
      .then(canEditCollective => {
        if (!canEditCollective) {
          let errorMsg;
          switch (collective.type) {
            case CollectiveType.EVENT:
              errorMsg = `You must be logged in as admin of the ${parentCollective.slug} collective to edit this Event.`;
              break;
            case CollectiveType.PROJECT:
              errorMsg = `You must be logged in as admin of the ${parentCollective.slug} collective to edit this Project.`;
              break;

            case CollectiveType.USER:
              errorMsg = `You must be logged in as ${newCollectiveData.name} to edit this User Collective`;
              break;

            default:
              errorMsg = `You must be logged in as an admin or as the host of this ${collective.type.toLowerCase()} collective to edit it`;
          }
          return Promise.reject(new Unauthorized(errorMsg));
        } else {
          return twoFactorAuthLib.enforceForAccount(req, collective, { onlyAskOnLogin: true });
        }
      })
      .then(async () => {
        // If we try to change the host
        // @deprecated This can now be done through dedicated `removeHost` mutation on GraphQL v2, but we still use it
        // in https://github.com/opencollective/opencollective-frontend/blob/f30fee8638573d317749052de3a37d30fe1112b0/components/edit-collective/sections/Host.js#L91.
        if (
          newCollectiveData.HostCollectiveId !== undefined &&
          newCollectiveData.HostCollectiveId !== collective.HostCollectiveId
        ) {
          return collective.changeHost(newCollectiveData.HostCollectiveId, req.remoteUser);
        }
      })
      .then(() => {
        // If we try to change the `hostFeePercent`
        if (
          newCollectiveData.hostFeePercent !== undefined &&
          newCollectiveData.hostFeePercent !== collective.hostFeePercent
        ) {
          return collective.updateHostFee(newCollectiveData.hostFeePercent, req.remoteUser);
        }
      })
      .then(() => {
        // if we try to change the `currency`
        if (newCollectiveData.currency !== undefined && newCollectiveData.currency !== collective.currency) {
          return collective.updateCurrency(newCollectiveData.currency, req.remoteUser);
        }
      })
      .then(() => {
        if (!isUndefined(args.collective.location)) {
          return collective.setLocation(args.collective.location);
        }
      })
      .then(() => {
        // Set private instructions value
        if (!isNil(args.collective.privateInstructions)) {
          newCollectiveData.data = {
            ...collective.data,
            privateInstructions: args.collective.privateInstructions,
          };
        }
        // we omit those attributes that have already been updated above
        return collective.update(omit(newCollectiveData, ['HostCollectiveId', 'hostFeePercent', 'currency']));
      })
      .then(async () => {
        const isSlEqual = (aSl, bSl) => aSl.type === bSl.type && aSl.url === bSl.url;

        if (args.collective.socialLinks) {
          return collective.updateSocialLinks(uniqWith(args.collective.socialLinks, isSlEqual));
        } else if (
          args.collective.website ||
          args.collective.repositoryUrl ||
          args.collective.githubHandle ||
          args.collective.twitterHandle
        ) {
          const socialLinks = await models.SocialLink.findAll({
            where: {
              CollectiveId: collective.id,
            },
            order: [['order', 'ASC']],
          });

          if (args.collective.website) {
            socialLinks.push({
              type: SocialLinkType.WEBSITE,
              url: args.collective.website,
            });
          }

          if (args.collective.repositoryUrl) {
            socialLinks.push({
              type: SocialLinkType.GIT,
              url: args.collective.repositoryUrl,
            });
          }

          if (args.collective.githubHandle) {
            socialLinks.push({
              type: SocialLinkType.GITHUB,
              url: `https://github.com/${args.collective.githubHandle}`,
            });
          }

          if (args.collective.twitterHandle) {
            socialLinks.push({
              type: SocialLinkType.TWITTER,
              url: `https://twitter.com/${args.collective.twitterHandle}`,
            });
          }

          return collective.updateSocialLinks(uniqWith(socialLinks, isSlEqual));
        }
      })
      .then(async () => {
        // Ask cloudflare to refresh the cache for this collective's page
        purgeCacheForCollective(collective.slug);
        const data = getCollectiveDataDiff(originalCollective, collective);
        // Create the activity which will store the data diff
        await models.Activity.create({
          type: activities.COLLECTIVE_EDITED,
          UserId: req.remoteUser.id,
          UserTokenId: req.userToken?.id,
          CollectiveId: collective.id,
          FromCollectiveId: collective.id,
          HostCollectiveId: collective.approvedAt ? collective.HostCollectiveId : null,
          data,
        });
        return collective;
      })
  );
}

/**
 * When archiving a collective, this function will mark all expenses that are not in a final state (paid, rejected, etc) as "CANCELED".
 */
const cancelUnprocessedExpenses = async (collectivesIds, remoteUser) => {
  return models.Expense.update(
    {
      status: 'CANCELED',
      lastEditedById: remoteUser.id,
      data: sequelize.literal(`
        COALESCE(data, '{}'::JSONB)
        || JSONB_BUILD_OBJECT('previousStatus', status)
        || JSONB_BUILD_OBJECT('cancelledWhileArchivedFromCollective', TRUE)
      `),
    },
    {
      returning: false,
      where: {
        status: ['DRAFT', 'UNVERIFIED', 'PENDING', 'INCOMPLETE', 'APPROVED', 'ERROR'],
        [Op.or]: [{ CollectiveId: collectivesIds }, { FromCollectiveId: collectivesIds }],
      },
    },
  );
};

export async function archiveCollective(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to archive a collective');
  }

  const collective = await req.loaders.Collective.byId.load(args.id);

  if (!collective) {
    throw new NotFound(`Collective with id ${args.id} not found`);
  }

  if (!req.remoteUser.isAdminOfCollective(collective) && !req.remoteUser.isRoot()) {
    throw new Unauthorized('You need to be logged in as an Admin.');
  }

  await twoFactorAuthLib.enforceForAccount(req, collective, { onlyAskOnLogin: true });

  if (await collective.isHost()) {
    throw new Error(
      `You can't archive your collective while being a host. Please, deactivate your collective as Host and try again.`,
    );
  }

  if (collective.isActive) {
    const balance = await collective.getBalance();
    if (balance > 0) {
      throw new Error('Cannot archive collective with balance > 0');
    }
  }

  const isChildren = collective.type === CollectiveType.EVENT || collective.type === CollectiveType.PROJECT;
  const slugsToClearCacheFor = [collective.slug];
  let children = [];
  if (!isChildren) {
    // Mark all children as archived, with a special `data.archivedFromParent` flag for later un-archive
    const deactivatedAt = new Date();
    [children] = await sequelize.query(
      `UPDATE "Collectives"
    SET "deactivatedAt" = :deactivatedAt,
    "data" = JSONB_SET(COALESCE("data", '{}'), '{archivedFromParent}', 'true')
    WHERE "ParentCollectiveId" = :collectiveId
    AND "deletedAt" IS NULL
    AND "deactivatedAt" IS NULL
    RETURNING *
    `,
      {
        type: QueryTypes.UPDATE,
        replacements: { collectiveId: collective.id, deactivatedAt },
        model: models.Collective,
        mapToModel: true,
      },
    );

    slugsToClearCacheFor.push(...children.map(c => c.slug));
  } else {
    // Purge cache for parent to make sure the card gets updated on the collective page
    const parent = await collective.getParentCollective();
    if (parent) {
      slugsToClearCacheFor.push(parent.slug);
    }
  }

  // Resets the host, which marks orders as CANCELLED and recursively unhost children
  await collective.changeHost(null, req.remoteUser, {
    isChildren,
    pauseContributions: false,
    messageForContributors: 'We are archiving this Collective.',
  });

  // Mark main account as archived
  await collective.update({ isActive: false, deactivatedAt: new Date() });

  // Cancel all subscriptions which the collective is contributing
  const allAccountIds = [collective.id, ...children.map(c => c.id)];
  await models.Order.cancelActiveOrdersByCollective(allAccountIds);

  // Cancel all unprocessed expenses
  await cancelUnprocessedExpenses(allAccountIds, req.remoteUser);

  // Clear caches
  for (const slug of slugsToClearCacheFor) {
    purgeCacheForCollective(slug);
  }

  return collective;
}

export async function unarchiveCollective(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to unarchive a collective');
  }

  const collective = await req.loaders.Collective.byId.load(args.id);
  if (!collective) {
    throw new NotFound(`Collective with id ${args.id} not found`);
  }

  if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Unauthorized('You need to be logged in as an Admin.');
  }

  await twoFactorAuthLib.enforceForAccount(req, collective, { onlyAskOnLogin: true });

  if (collective.type === CollectiveType.EVENT || collective.type === CollectiveType.PROJECT) {
    const parentCollective = await req.loaders.Collective.byId.load(collective.ParentCollectiveId);
    const updatedCollective = collective.update({
      deactivatedAt: null,
      isActive: parentCollective.isActive,
      HostCollectiveId: parentCollective.HostCollectiveId,
      approvedAt: collective.approvedAt || Date.now(),
    });

    // purge cache for parent to make sure the card gets updated on the collective page
    purgeCacheForCollective(parentCollective.slug);
    return updatedCollective;
  }

  return collective.update({ deactivatedAt: null });
}

export async function deleteCollective(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to delete a collective');
  }

  const collective = await req.loaders.Collective.byId.load(args.id);
  if (!collective) {
    throw new NotFound(`Collective with id ${args.id} not found`);
  }

  if (!req.remoteUser.isAdminOfCollective(collective) && !req.remoteUser.isRoot()) {
    throw new Unauthorized(`You don't have permission to delete this collective.`);
  }

  if (await collective.isHost()) {
    throw new Error(
      `You can't delete your collective while being a host. Please, deactivate your collective as Host and try again.`,
    );
  }

  if (!(await collectivelib.isCollectiveDeletable(collective))) {
    throw new Error(
      `You can't delete a collective with children, transactions, orders or paid expenses. Please archive it instead.`,
    );
  }

  await twoFactorAuthLib.enforceForAccount(req, collective, { alwaysAskForToken: true });

  return collectivelib.deleteCollective(collective);
}

export async function activateCollectiveAsHost(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to activate a collective as Host.');
  }

  const collective = await req.loaders.Collective.byId.load(args.id);
  if (!collective) {
    throw new NotFound(`Collective with id ${args.id} not found`);
  }

  if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Unauthorized('You need to be logged in as an Admin.');
  }

  await twoFactorAuthLib.enforceForAccount(req, collective, { onlyAskOnLogin: true });

  return collective.becomeHost(req.remoteUser);
}

export async function deactivateCollectiveAsHost(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to deactivate a collective as Host.');
  }

  const collective = await req.loaders.Collective.byId.load(args.id);
  if (!collective) {
    throw new NotFound(`Collective with id ${args.id} not found`);
  }

  if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Unauthorized('You need to be logged in as an Admin.');
  }

  await twoFactorAuthLib.enforceForAccount(req, collective, { onlyAskOnLogin: true });

  return collective.deactivateAsHost();
}

export async function activateBudget(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to activate budget.');
  }

  const collective = await req.loaders.Collective.byId.load(args.id);
  if (!collective) {
    throw new NotFound(`Collective with id ${args.id} not found`);
  }

  if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Unauthorized('You need to be logged in as an Admin.');
  }

  await twoFactorAuthLib.enforceForAccount(req, collective, { onlyAskOnLogin: true });

  return collective.activateBudget();
}

export async function deactivateBudget(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to deactivate budget.');
  }

  const collective = await req.loaders.Collective.byId.load(args.id);
  if (!collective) {
    throw new NotFound(`Collective with id ${args.id} not found`);
  }

  if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Unauthorized('You need to be logged in as an Admin.');
  }

  await twoFactorAuthLib.enforceForAccount(req, collective, { onlyAskOnLogin: true });

  return collective.deactivateBudget();
}
