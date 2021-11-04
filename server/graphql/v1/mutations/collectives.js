import { map } from 'bluebird';
import config from 'config';
import slugify from 'limax';
import { get, omit, truncate } from 'lodash';
import sanitize from 'sanitize-html';
import { v4 as uuid } from 'uuid';

import activities from '../../../constants/activities';
import { types } from '../../../constants/collectives';
import FEATURE from '../../../constants/feature';
import roles from '../../../constants/roles';
import { purgeCacheForCollective } from '../../../lib/cache';
import emailLib from '../../../lib/email';
import * as github from '../../../lib/github';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../../lib/rate-limit';
import { canUseFeature } from '../../../lib/user-permissions';
import { defaultHostCollective } from '../../../lib/utils';
import models, { Op } from '../../../models';
import { FeatureNotAllowedForUser, NotFound, RateLimitExceeded, Unauthorized, ValidationFailed } from '../../errors';

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
  if (parentCollective && parentCollective.hostFeePercent !== collective.hostFeePercent) {
    await collective.update({ hostFeePercent: parentCollective.hostFeePercent });
  }

  // if the type of collective is an organization or an event, we don't send notification

  return collective;
}

export async function createCollectiveFromGithub(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to create a collective');
  }

  if (!args.collective.name) {
    throw new ValidationFailed('collective.name required');
  }

  let collective;
  const user = req.remoteUser;
  const githubHandle = args.collective.githubHandle;
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

  const data = {
    firstName: user.firstName,
    lastName: user.lastName,
    collective: collective.info,
  };

  await emailLib.send('github.signup', user.email, data);

  models.Activity.create({
    type: activities.COLLECTIVE_CREATED_GITHUB,
    UserId: user.id,
    CollectiveId: collective.id,
    data: {
      collective: collective.info,
      host: host.info,
      user: user.info,
    },
  });

  return collective;
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

  // Set location values
  const location = args.collective.location || {};
  if (location.lat) {
    newCollectiveData.geoLocationLatLong = {
      type: 'Point',
      coordinates: [location.lat, location.long],
    };
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

  let collective, parentCollective;

  return req.loaders.Collective.byId
    .load(args.collective.id)
    .then(c => {
      if (!c) {
        throw new Error(`Collective with id ${args.collective.id} not found`);
      }
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
      if (args.collective.privateInstructions) {
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
    .then(() => {
      // Ask cloudflare to refresh the cache for this collective's page
      purgeCacheForCollective(collective.slug);
      return collective;
    });
}

export async function archiveCollective(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to archive a collective');
  }

  const collective = await models.Collective.findByPk(args.id);
  if (!collective) {
    throw new NotFound(`Collective with id ${args.id} not found`);
  }

  if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Unauthorized('You need to be logged in as an Admin.');
  }

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

  // TODO: cascade deactivation to EVENTs and PROJECTs?

  return collective.update({ isActive: false, deactivatedAt: Date.now(), approvedAt: null, HostCollectiveId: null });
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

  if (await collective.isHost()) {
    throw new Error(
      `You can't delete your collective while being a host. Please, Desactivate your collective as Host and try again.`,
    );
  }

  if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Unauthorized('You need to be logged in as an Admin.');
  }

  const transactionCount = await models.Transaction.count({
    where: {
      [Op.or]: [{ CollectiveId: collective.id }, { FromCollectiveId: collective.id }],
    },
  });
  const orderCount = await models.Order.count({
    where: {
      [Op.or]: [{ CollectiveId: collective.id }, { FromCollectiveId: collective.id }],
      status: ['PAID', 'ACTIVE', 'CANCELLED'],
    },
  });

  if (transactionCount > 0 || orderCount > 0) {
    throw new Error('Can not delete collective with existing orders.');
  }

  const expenseCount = await models.Expense.count({
    where: {
      [Op.or]: [{ FromCollectiveId: collective.id }, { CollectiveId: collective.id }],
      status: ['PAID', 'PROCESSING', 'SCHEDULED_FOR_PAYMENT'],
    },
  });

  if (expenseCount > 0) {
    throw new Error('Can not delete collective with paid expenses.');
  }

  const eventCount = await models.Collective.count({
    where: { ParentCollectiveId: collective.id, type: types.EVENT },
  });

  if (eventCount > 0) {
    throw new Error('Can not delete collective with events.');
  }

  return models.Member.findAll({
    where: {
      [Op.or]: [{ CollectiveId: collective.id }, { MemberCollectiveId: collective.id }],
    },
  })
    .then(members => {
      return map(
        members,
        member => {
          return member.destroy();
        },
        { concurrency: 3 },
      );
    })

    .then(async () => {
      const orders = await models.Order.findAll({
        where: {
          [Op.or]: [{ FromCollectiveId: collective.id }, { CollectiveId: collective.id }],
          status: { [Op.not]: ['PAID', 'ACTIVE', 'CANCELLED'] },
        },
      });
      return map(
        orders,
        order => {
          return order.destroy();
        },
        { concurrency: 3 },
      );
    })

    .then(async () => {
      const expenses = await models.Expense.findAll({
        where: {
          [Op.or]: [{ FromCollectiveId: collective.id }, { CollectiveId: collective.id }],
          status: { [Op.not]: ['PAID', 'PROCESSING', 'SCHEDULED_FOR_PAYMENT'] },
        },
      });
      return map(
        expenses,
        expense => {
          return expense.destroy();
        },
        { concurrency: 3 },
      );
    })

    .then(async () => {
      const tiers = await models.Tier.findAll({
        where: { CollectiveId: collective.id },
      });
      return map(
        tiers,
        tier => {
          return tier.destroy();
        },
        { concurrency: 3 },
      );
    })

    .then(async () => {
      const paymentMethods = await models.PaymentMethod.findAll({
        where: { CollectiveId: collective.id },
      });
      return map(
        paymentMethods,
        paymentMethod => {
          return paymentMethod.destroy();
        },
        { concurrency: 3 },
      );
    })

    .then(async () => {
      const connectedAccounts = await models.ConnectedAccount.findAll({
        where: { CollectiveId: collective.id },
      });
      return map(
        connectedAccounts,
        connectedAccount => {
          return connectedAccount.destroy();
        },
        { concurrency: 3 },
      );
    })

    .then(async () => {
      const memberInvitations = await models.MemberInvitation.findAll({
        where: { CollectiveId: collective.id },
      });
      return map(
        memberInvitations,
        memberInvitation => {
          return memberInvitation.destroy();
        },
        { concurrency: 3 },
      );
    })

    .then(() => collective.destroy())
    .then(() => collective);
}

export async function deleteUserCollective(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to delete this account.');
  }

  const collective = await models.Collective.findByPk(args.id);
  if (!collective) {
    throw new NotFound(`Account with id ${args.id} not found`);
  }
  if (!req.remoteUser.isAdminOfCollective(collective) && !req.remoteUser.isRoot()) {
    throw new Unauthorized(`You don't have permission to delete this account.`);
  }

  const user = await models.User.findOne({ where: { CollectiveId: collective.id } });

  const transactionCount = await models.Transaction.count({
    where: { FromCollectiveId: collective.id },
  });
  const orderCount = await models.Order.count({
    where: { FromCollectiveId: collective.id },
  });

  if (transactionCount > 0 || orderCount > 0) {
    throw new Error('Can not delete user with existing orders or transactions.');
  }

  const expenseCount = await models.Expense.count({
    where: {
      [Op.or]: [{ CollectiveId: collective.id }, { FromCollectiveId: collective.id }],
      status: ['PAID', 'PROCESSING', 'SCHEDULED_FOR_PAYMENT'],
    },
  });
  if (expenseCount > 0) {
    throw new Error('Can not delete user with paid expenses.');
  }

  const members = await models.Member.findAll({
    where: { MemberCollectiveId: collective.id },
    include: [{ model: models.Collective, as: 'collective' }],
  });

  const adminMembership = members.filter(m => m.role === roles.ADMIN);
  if (adminMembership.length >= 1) {
    for (const member of adminMembership) {
      const admins = await member.collective.getAdmins();
      if (admins.length === 1) {
        throw new Error(
          `Your account cannot be deleted, you're the only admin of ${member.collective.name}, please delete the collective or add a new admin.`,
        );
      }
    }
  }

  return map(
    members,
    member => {
      return member.destroy();
    },
    { concurrency: 3 },
  )
    .then(async () => {
      const expenses = await models.Expense.findAll({
        where: {
          [Op.or]: [{ CollectiveId: collective.id }, { FromCollectiveId: collective.id }],
          status: { [Op.not]: ['PAID', 'PROCESSING', 'SCHEDULED_FOR_PAYMENT'] },
        },
      });
      return map(
        expenses,
        expense => {
          return expense.destroy();
        },
        { concurrency: 3 },
      );
    })

    .then(async () => {
      const paymentMethods = await models.PaymentMethod.findAll({
        where: { CollectiveId: collective.id },
      });
      return map(
        paymentMethods,
        paymentMethod => {
          return paymentMethod.destroy();
        },
        { concurrency: 3 },
      );
    })

    .then(async () => {
      const connectedAccounts = await models.ConnectedAccount.findAll({
        where: { CollectiveId: collective.id },
      });
      return map(
        connectedAccounts,
        connectedAccount => {
          return connectedAccount.destroy();
        },
        { concurrency: 3 },
      );
    })

    .then(() => {
      // Update collective slug to free the current slug for future
      const newSlug = `${collective.slug}-${Date.now()}`;
      return collective.update({ slug: newSlug });
    })
    .then(() => {
      return collective.destroy();
    })

    .then(() => {
      // Update user email in order to free up for future reuse
      // Split the email, username from host domain
      const splitedEmail = user.email.split('@');
      // Add the current timestamp to email username
      const newEmail = `${splitedEmail[0]}-${Date.now()}@${splitedEmail[1]}`;
      return user.update({ email: newEmail });
    })
    .then(() => {
      return user.destroy();
    })
    .then(() => collective);
}

export async function sendMessageToCollective(_, args, req) {
  const user = req.remoteUser;
  if (!canUseFeature(user, FEATURE.CONTACT_COLLECTIVE)) {
    throw new FeatureNotAllowedForUser(
      'You are not authorized to contact Collectives. Please contact support@opencollective.com if you think this is an error.',
    );
  }

  const collective = await models.Collective.findByPk(args.collectiveId);
  if (!collective) {
    throw new NotFound(`Collective with id ${args.id} not found`);
  }

  if (!(await collective.canContact())) {
    throw new Unauthorized(`You can't contact this collective`);
  }

  const message = args.message && sanitize(args.message, { allowedTags: [], allowedAttributes: {} }).trim();
  if (!message || message.length < 10) {
    throw new Error('Message is too short');
  }

  const subject =
    args.subject && sanitize(args.subject, { allowedTags: [], allowedAttributes: {} }).trim().slice(0, 60);

  // User sending the email must have an associated collective
  const fromCollective = await models.Collective.findByPk(user.CollectiveId);
  if (!fromCollective) {
    throw new Error("Your user account doesn't have any profile associated. Please contact support");
  }

  // Limit email sent per user
  const maxEmailMessagePerHour = config.limits.collectiveEmailMessagePerHour;
  const cacheKey = `user_contact_send_message_${user.id}`;
  const rateLimit = new RateLimit(cacheKey, maxEmailMessagePerHour, ONE_HOUR_IN_SECONDS);
  if (!(await rateLimit.registerCall())) {
    throw new RateLimitExceeded('Too many messages sent in a limited time frame. Please try again later.');
  }

  // Create the activity (which will send the message to the users)
  await models.Activity.create({
    type: activities.COLLECTIVE_CONTACT,
    UserId: user.id,
    CollectiveId: collective.id,
    data: {
      fromCollective,
      collective,
      user,
      subject: subject || null,
      message: message,
    },
  });

  return { success: true };
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

  return collective.deactivateBudget();
}
