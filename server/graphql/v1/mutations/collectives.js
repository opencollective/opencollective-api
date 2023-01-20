import config from 'config';
import slugify from 'limax';
import { cloneDeep, get, isEqual, isNil, omit, pick, truncate } from 'lodash';
import { v4 as uuid } from 'uuid';

import activities from '../../../constants/activities';
import { types } from '../../../constants/collectives';
import roles from '../../../constants/roles';
import { purgeCacheForCollective } from '../../../lib/cache';
import * as collectivelib from '../../../lib/collectivelib';
import * as github from '../../../lib/github';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import { defaultHostCollective } from '../../../lib/utils';
import models, { sequelize } from '../../../models';
import { NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { CollectiveInputType } from '../inputTypes';

const DEFAULT_COLLECTIVE_SETTINGS = {
  features: { conversations: true },
};

export async function createCollective(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to create a collective');
  }

  if (!args.collective.name) {
    throw new ValidationFailed('collective.name required');
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

  const location = args.collective.location;
  if (location) {
    collectiveData.locationName = location.name;
    collectiveData.address = location.address;
    collectiveData.countryISO = location.country;
    if (location.lat) {
      collectiveData.geoLocationLatLong = {
        type: 'Point',
        coordinates: [location.lat, location.long],
      };
    }
  }
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

    // The currency of the new created collective if not specified should be the one of its direct parent or the host (in this order)
    collectiveData.currency = collectiveData.currency || parentCollective.currency;
    collectiveData.HostCollectiveId = parentCollective.HostCollectiveId;

    if (collectiveData.type === types.EVENT) {
      collectiveData.platformFeePercent = parentCollective.platformFeePercent;
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
  if (collectiveData.type === types.EVENT) {
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
    const host = await models.Collective.findByPk(defaultHostCollective('opensource').CollectiveId);
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

  const host = await models.Collective.findByPk(defaultHostCollective('opensource').CollectiveId);
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

  // Set location values
  let location;
  if (args.collective.location === null) {
    location = {
      name: null,
      address: null,
      lat: null,
      long: null,
      country: null,
    };
  } else {
    location = args.collective.location || {};
  }

  if (location.lat) {
    newCollectiveData.geoLocationLatLong = {
      type: 'Point',
      coordinates: [location.lat, location.long],
    };
  } else if (location.lat === null) {
    newCollectiveData.geoLocationLatLong = null;
  }
  if (location.name !== undefined) {
    newCollectiveData.locationName = location.name;
  }
  if (location.address !== undefined) {
    newCollectiveData.address = location.address;
  }
  if (location.country !== undefined) {
    newCollectiveData.countryISO = location.country;
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
            case types.EVENT:
              errorMsg = `You must be logged in as admin of the ${parentCollective.slug} collective to edit this Event.`;
              break;
            case types.PROJECT:
              errorMsg = `You must be logged in as admin of the ${parentCollective.slug} collective to edit this Project.`;
              break;

            case types.USER:
              errorMsg = `You must be logged in as ${newCollectiveData.name} to edit this User Collective`;
              break;

            default:
              errorMsg = `You must be logged in as an admin or as the host of this ${collective.type.toLowerCase()} collective to edit it`;
          }
          return Promise.reject(new Unauthorized(errorMsg));
        } else {
          return twoFactorAuthLib.enforceForAccountAdmins(req, collective, { onlyAskOnLogin: true });
        }
      })
      .then(async () => {
        // If we try to change the host
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
      .then(() => collective.editTiers(args.collective.tiers))
      .then(() => {
        // @deprecated since 2019-10-21: now using dedicated `editCoreContributors` endpoint
        if (args.collective.members) {
          return collective.editMembers(args.collective.members, {
            CreatedByUserId: req.remoteUser.id,
            remoteUserCollectiveId: req.remoteUser.CollectiveId,
          });
        }
      })
      .then(async () => {
        if (args.collective.socialLinks) {
          return collective.updateSocialLinks(args.collective.socialLinks);
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

export async function archiveCollective(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to archive a collective');
  }

  const collective = await models.Collective.findByPk(args.id);

  if (!collective) {
    throw new NotFound(`Collective with id ${args.id} not found`);
  }

  if (!req.remoteUser.isAdminOfCollective(collective) && !req.remoteUser.isRoot()) {
    throw new Unauthorized('You need to be logged in as an Admin.');
  }

  await twoFactorAuthLib.enforceForAccountAdmins(req, collective, { onlyAskOnLogin: true });

  if (await collective.isHost()) {
    throw new Error(
      `You can't archive your collective while being a host. Please, Desactivate your collective as Host and try again.`,
    );
  }

  if (collective.isActive) {
    const balance = await collective.getBalance();
    if (balance > 0) {
      throw new Error('Cannot archive collective with balance > 0');
    }
  }

  // Trigger archive
  const membership = await models.Member.findOne({
    where: {
      CollectiveId: collective.id,
      MemberCollectiveId: collective.HostCollectiveId,
      role: roles.HOST,
    },
  });

  if (membership) {
    membership.destroy();
  }

  if (collective.type === types.EVENT || collective.type === types.PROJECT) {
    const updatedCollective = await collective.update({ isActive: false, deactivatedAt: Date.now() });
    const parent = await updatedCollective.getParentCollective();
    if (parent) {
      // purge cache for parent to make sure the card gets updated on the collective page
      purgeCacheForCollective(parent.slug);
    }

    return updatedCollective;
  }

  // `changeHost` will recursively check children and unhost them
  await collective.changeHost(null);

  // Mark all children as archived, with a special `data.archivedFromParent` flag for later un-archive
  const deactivatedAt = new Date();
  await sequelize.query(
    `UPDATE "Collectives"
    SET "deactivatedAt" = :deactivatedAt,
        "data" = JSONB_SET(COALESCE("data", '{}'), '{archivedFromParent}', 'true')
    WHERE "ParentCollectiveId" = :collectiveId
    AND "deletedAt" IS NULL
    AND "deactivatedAt" IS NULL
  `,
    {
      replacements: { collectiveId: collective.id, deactivatedAt },
    },
  );

  // Cancel all subscriptions which the collective is contributing
  await models.Order.cancelActiveOrdersByCollective(collective.id);

  // Mark main account as archived
  return collective.update({ deactivatedAt });
}

export async function unarchiveCollective(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to unarchive a collective');
  }

  const collective = await models.Collective.findByPk(args.id);
  if (!collective) {
    throw new NotFound(`Collective with id ${args.id} not found`);
  }

  if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Unauthorized('You need to be logged in as an Admin.');
  }

  await twoFactorAuthLib.enforceForAccountAdmins(req, collective, { onlyAskOnLogin: true });

  if (collective.type === types.EVENT || collective.type === types.PROJECT) {
    const parentCollective = await models.Collective.findByPk(collective.ParentCollectiveId);
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

  const collective = await models.Collective.findByPk(args.id);
  if (!collective) {
    throw new NotFound(`Collective with id ${args.id} not found`);
  }

  if (!req.remoteUser.isAdminOfCollective(collective) && !req.remoteUser.isRoot()) {
    throw new Unauthorized(`You don't have permission to delete this collective.`);
  }

  if (await collective.isHost()) {
    throw new Error(
      `You can't delete your collective while being a host. Please, Desactivate your collective as Host and try again.`,
    );
  }

  if (!(await collectivelib.isCollectiveDeletable(collective))) {
    throw new Error(
      `You can't delete a collective with children, transactions, orders or paid expenses. Please archive it instead.`,
    );
  }

  await twoFactorAuthLib.enforceForAccountAdmins(req, collective, { alwaysAskForToken: true });

  return collectivelib.deleteCollective(collective);
}

export async function activateCollectiveAsHost(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to activate a collective as Host.');
  }

  const collective = await models.Collective.findByPk(args.id);
  if (!collective) {
    throw new NotFound(`Collective with id ${args.id} not found`);
  }

  if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Unauthorized('You need to be logged in as an Admin.');
  }

  await twoFactorAuthLib.enforceForAccountAdmins(req, collective, { onlyAskOnLogin: true });

  return collective.becomeHost();
}

export async function deactivateCollectiveAsHost(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to deactivate a collective as Host.');
  }

  const collective = await models.Collective.findByPk(args.id);
  if (!collective) {
    throw new NotFound(`Collective with id ${args.id} not found`);
  }

  if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Unauthorized('You need to be logged in as an Admin.');
  }

  await twoFactorAuthLib.enforceForAccountAdmins(req, collective, { onlyAskOnLogin: true });

  return collective.deactivateAsHost();
}

export async function activateBudget(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to activate budget.');
  }

  const collective = await models.Collective.findByPk(args.id);
  if (!collective) {
    throw new NotFound(`Collective with id ${args.id} not found`);
  }

  if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Unauthorized('You need to be logged in as an Admin.');
  }

  await twoFactorAuthLib.enforceForAccountAdmins(req, collective, { onlyAskOnLogin: true });

  return collective.activateBudget();
}

export async function deactivateBudget(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to deactivate budget.');
  }

  const collective = await models.Collective.findByPk(args.id);
  if (!collective) {
    throw new NotFound(`Collective with id ${args.id} not found`);
  }

  if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Unauthorized('You need to be logged in as an Admin.');
  }

  await twoFactorAuthLib.enforceForAccountAdmins(req, collective, { onlyAskOnLogin: true });

  return collective.deactivateBudget();
}
