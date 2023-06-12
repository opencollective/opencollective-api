/* eslint-disable camelcase */
import express from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';

import { activities } from '../../../constants';
import POLICIES from '../../../constants/policies';
import logger from '../../../lib/logger';
import { getPolicy } from '../../../lib/policies';
import { reportErrorToSentry } from '../../../lib/sentry';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models from '../../../models';
import VirtualCardModel, { VirtualCardStatus } from '../../../models/VirtualCard';
import * as stripe from '../../../paymentProviders/stripe/virtual-cards';
import { checkRemoteUserCanUseVirtualCards } from '../../common/scope-check';
import { BadRequest, NotFound, Unauthorized } from '../../errors';
import { GraphQLVirtualCardLimitInterval } from '../enum/VirtualCardLimitInterval';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { getValueInCentsFromAmountInput, GraphQLAmountInput } from '../input/AmountInput';
import { GraphQLVirtualCardInput } from '../input/VirtualCardInput';
import { GraphQLVirtualCardReferenceInput } from '../input/VirtualCardReferenceInput';
import { GraphQLVirtualCard } from '../object/VirtualCard';

const virtualCardMutations = {
  assignNewVirtualCard: {
    description: 'Assign Virtual Card information to existing hosted collective. Scope: "virtualCards".',
    type: new GraphQLNonNull(GraphQLVirtualCard),
    args: {
      virtualCard: {
        type: new GraphQLNonNull(GraphQLVirtualCardInput),
        description: 'Virtual Card data',
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account where the virtual card will be associated',
      },
      assignee: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Individual account responsible for the card',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<VirtualCardModel> {
      checkRemoteUserCanUseVirtualCards(req);

      const collective = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      const host = await collective.getHostCollective();
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized("You don't have permission to edit this collective");
      }

      // Enforce 2FA
      await twoFactorAuthLib.enforceForAccount(req, host);

      const assignee = await fetchAccountWithReference(args.assignee, {
        loaders: req.loaders,
        throwIfMissing: true,
      });
      const user = await assignee.getUser();
      if (!user) {
        throw new BadRequest('Could not find the assigned user');
      }

      const { cardNumber, expiryDate, cvv } = args.virtualCard.privateData;

      if (!cardNumber || !expiryDate || !cvv) {
        throw new BadRequest('VirtualCard missing cardNumber, expiryDate and/or cvv', undefined, {
          cardNumber: !cardNumber && 'Card Number is required',
          expiryDate: !expiryDate && 'Expiry Date is required',
          cvv: !cvv && 'CVV is required',
        });
      }

      const virtualCard = await stripe.assignCardToCollective(
        cardNumber,
        expiryDate,
        cvv,
        args.virtualCard.name,
        collective.id,
        host,
        user.id,
      );

      await models.Activity.create({
        type: activities.COLLECTIVE_VIRTUAL_CARD_ADDED,
        UserId: req.remoteUser.id,
        UserTokenId: req.userToken?.id,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        data: {
          assignee: assignee.activity,
          collective: collective.activity,
          host: host.activity,
        },
      }).catch(e => {
        logger.error('An error occurred when creating the COLLECTIVE_VIRTUAL_CARD_ADDED activity', e);
        reportErrorToSentry(e);
      });

      return virtualCard;
    },
  },
  createVirtualCard: {
    description: 'Create new Stripe Virtual Card for existing hosted collective. Scope: "virtualCards".',
    type: new GraphQLNonNull(GraphQLVirtualCard),
    args: {
      name: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'Virtual card name',
      },
      limitAmount: {
        type: new GraphQLNonNull(GraphQLAmountInput),
        description: 'Virtual card limit amount',
      },
      limitInterval: {
        type: new GraphQLNonNull(GraphQLVirtualCardLimitInterval),
        description: 'Virtual card limit interval',
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account where the virtual card will be associated',
      },
      assignee: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Individual account responsible for the virtual card',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<VirtualCardModel> {
      checkRemoteUserCanUseVirtualCards(req);

      const collective = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      const host = await collective.getHostCollective();

      const limitAmountInCents = getValueInCentsFromAmountInput(args.limitAmount, {
        expectedCurrency: host.currency,
      });

      const { limitInterval } = args;

      const virtualCardMaximumLimitForIntervalPolicy = await getPolicy(
        host,
        POLICIES.MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL,
      );
      const maximumLimitForInterval = virtualCardMaximumLimitForIntervalPolicy[limitInterval];

      if (limitAmountInCents > maximumLimitForInterval * 100) {
        throw new BadRequest(
          `Limit for interval should not exceed ${maximumLimitForInterval} ${host.currency}`,
          undefined,
          {
            limitAmount: `Limit for interval should not exceed ${maximumLimitForInterval} ${host.currency}`,
          },
        );
      }

      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized("You don't have permission to edit this collective");
      }

      // Enforce 2FA
      await twoFactorAuthLib.enforceForAccount(req, host);

      const assignee = await fetchAccountWithReference(args.assignee, {
        loaders: req.loaders,
        throwIfMissing: true,
      });

      const user = await assignee.getUser();

      if (!user) {
        throw new BadRequest('Could not find the assigned user');
      }

      const virtualCard = await stripe.createVirtualCard(
        host,
        collective,
        user.id,
        args.name,
        limitAmountInCents,
        limitInterval,
      );

      await models.Activity.create({
        type: activities.COLLECTIVE_VIRTUAL_CARD_ADDED,
        UserId: req.remoteUser.id,
        UserTokenId: req.userToken?.id,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        data: {
          assignee: assignee.activity,
          collective: collective.activity,
          host: host.activity,
        },
      }).catch(e => {
        logger.error('An error occurred when creating the COLLECTIVE_VIRTUAL_CARD_ADDED activity', e);
        reportErrorToSentry(e);
      });

      return virtualCard;
    },
  },
  editVirtualCard: {
    description: 'Edit existing Virtual Card information. Scope: "virtualCards".',
    type: new GraphQLNonNull(GraphQLVirtualCard),
    args: {
      virtualCard: {
        type: new GraphQLNonNull(GraphQLVirtualCardReferenceInput),
        description: 'Virtual card reference',
      },
      name: {
        type: GraphQLString,
        description: 'Virtual card name',
      },
      assignee: {
        type: GraphQLAccountReferenceInput,
        description: 'Individual account responsible for the card',
      },
      limitAmount: {
        type: GraphQLAmountInput,
        description: 'Virtual card limit amount',
      },
      limitInterval: {
        type: GraphQLVirtualCardLimitInterval,
        description: 'Virtual card limit interval',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<VirtualCardModel> {
      checkRemoteUserCanUseVirtualCards(req);

      const virtualCard = await models.VirtualCard.findOne({
        where: { id: args.virtualCard.id },
        include: [
          { association: 'host', required: true },
          { association: 'collective', required: true },
        ],
      });

      if (!virtualCard) {
        throw new NotFound('Could not find Virtual Card');
      }

      if (args.limitAmount && !req.remoteUser.isAdmin(virtualCard.HostCollectiveId)) {
        throw new Unauthorized("You don't have permission to update this Virtual Card's limit");
      } else if (req.remoteUser.isAdminOfCollective(virtualCard.collective)) {
        await twoFactorAuthLib.enforceForAccount(req, virtualCard.collective);
      } else if (req.remoteUser.isAdminOfCollective(virtualCard.host)) {
        await twoFactorAuthLib.enforceForAccount(req, virtualCard.host);
      } else {
        throw new Unauthorized("You don't have permission to update this Virtual Card");
      }

      if (virtualCard.data.status === VirtualCardStatus.CANCELED) {
        throw new BadRequest('This Virtual Card cannot be edited');
      }

      const updateAttributes = {};

      if (args.assignee) {
        const userCollective = await fetchAccountWithReference(args.assignee, {
          loaders: req.loaders,
        });

        const user = await userCollective.getUser();

        if (!user) {
          throw new BadRequest('Could not find the assigned user');
        }

        updateAttributes['UserId'] = user.id;
      }

      if (args.name) {
        updateAttributes['name'] = args.name;
      }

      if (args.limitAmount) {
        if (!args.limitInterval) {
          throw new BadRequest('Limit interval must be set');
        }

        const { limitInterval } = args;
        const virtualCardMaximumLimitForIntervalPolicy = await getPolicy(
          virtualCard.host,
          POLICIES.MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL,
        );
        const maximumLimitForInterval = virtualCardMaximumLimitForIntervalPolicy[limitInterval];

        const limitAmountInCents = getValueInCentsFromAmountInput(args.limitAmount, {
          expectedCurrency: virtualCard.host.currency,
        });

        if (limitAmountInCents > maximumLimitForInterval * 100) {
          throw new BadRequest(
            `Limit for interval should not exceed ${maximumLimitForInterval} ${virtualCard.host.currency}`,
            undefined,
            {
              limitAmount: `Limit for interval should not exceed ${maximumLimitForInterval} ${virtualCard.host.currency}`,
            },
          );
        }

        updateAttributes['spendingLimitAmount'] = limitAmountInCents;
        updateAttributes['spendingLimitInterval'] = args.limitInterval;

        await stripe.updateVirtualCardLimit(virtualCard, limitAmountInCents, args.limitInterval);
      }

      return virtualCard.update(updateAttributes);
    },
  },
  requestVirtualCard: {
    description: 'Request Virtual Card to host. Scope: "virtualCards".',
    type: GraphQLBoolean,
    args: {
      notes: {
        type: GraphQLString,
        description: 'Request notes',
      },
      purpose: {
        type: GraphQLString,
        description: 'Purpose for this Virtual Card',
      },
      budget: {
        type: GraphQLInt,
        description: 'Monthly budget you want for this Virtual Card',
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account where the virtual card will be associated',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<boolean> {
      checkRemoteUserCanUseVirtualCards(req);

      const collective = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Unauthorized("You don't have permission to request a virtual card for this collective");
      }

      // Check 2FA
      await twoFactorAuthLib.enforceForAccount(req, collective);

      const host = await collective.getHostCollective();
      const userCollective = await req.remoteUser.getCollective();
      const activity = {
        type: activities.VIRTUAL_CARD_REQUESTED,
        UserId: req.remoteUser.id,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        data: {
          host: host.activity,
          collective: { ...collective.activity, path: await collective.getUrlPath() },
          userCollective: userCollective.activity,
          user: req.remoteUser.minimal,
          notes: args.notes,
          budget: args.budget,
          purpose: args.purpose,
        },
      };

      await models.Activity.create(activity);

      return true;
    },
  },
  pauseVirtualCard: {
    description: 'Pause active Virtual Card. Scope: "virtualCards".',
    type: new GraphQLNonNull(GraphQLVirtualCard),
    args: {
      virtualCard: {
        type: new GraphQLNonNull(GraphQLVirtualCardReferenceInput),
        description: 'Virtual Card reference',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<VirtualCardModel> {
      checkRemoteUserCanUseVirtualCards(req);

      const virtualCard = await models.VirtualCard.findOne({
        where: { id: args.virtualCard.id },
        include: [
          {
            model: models.Collective,
            as: 'collective',
          },
          {
            model: models.Collective,
            as: 'host',
          },
        ],
      });
      if (!virtualCard) {
        throw new NotFound('Could not find Virtual Card');
      }

      if (req.remoteUser.isAdmin(virtualCard.HostCollectiveId)) {
        await twoFactorAuthLib.enforceForAccount(req, virtualCard.host);
      } else if (req.remoteUser.isAdmin(virtualCard.CollectiveId)) {
        await twoFactorAuthLib.enforceForAccount(req, virtualCard.collective);
      } else {
        throw new Unauthorized("You don't have permission to pause this Virtual Card");
      }

      if (virtualCard.data.status === VirtualCardStatus.CANCELED) {
        throw new BadRequest('This Virtual Card cannot be edited');
      }

      const card = await virtualCard.pause();
      const data = {
        virtualCard,
        host: virtualCard.host.info,
        collective: virtualCard.collective.info,
      };
      await models.Activity.create({
        type: activities.COLLECTIVE_VIRTUAL_CARD_SUSPENDED,
        CollectiveId: virtualCard.collective.id,
        HostCollectiveId: virtualCard.host.id,
        UserId: req.remoteUser.id,
        data,
      });

      return card;
    },
  },
  resumeVirtualCard: {
    description: 'Resume paused Virtual Card. Scope: "virtualCards".',
    type: new GraphQLNonNull(GraphQLVirtualCard),
    args: {
      virtualCard: {
        type: new GraphQLNonNull(GraphQLVirtualCardReferenceInput),
        description: 'Virtual Card reference',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<VirtualCardModel> {
      checkRemoteUserCanUseVirtualCards(req);

      const virtualCard = await models.VirtualCard.findOne({
        where: { id: args.virtualCard.id },
        include: [{ association: 'host', required: true }],
      });
      if (!virtualCard) {
        throw new NotFound('Could not find Virtual Card');
      }

      if (!req.remoteUser.isAdmin(virtualCard.HostCollectiveId)) {
        throw new Unauthorized("You don't have permission to edit this Virtual Card");
      }

      if (virtualCard.data.status === VirtualCardStatus.CANCELED) {
        throw new BadRequest('This Virtual Card cannot be activated');
      }

      return virtualCard.resume();
    },
  },
  deleteVirtualCard: {
    description: 'Delete Virtual Card. Scope: "virtualCards".',
    type: GraphQLBoolean,
    args: {
      virtualCard: {
        type: new GraphQLNonNull(GraphQLVirtualCardReferenceInput),
        description: 'Virtual Card reference',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<boolean> {
      checkRemoteUserCanUseVirtualCards(req);

      const virtualCard = await models.VirtualCard.findOne({
        where: { id: args.virtualCard.id },
        include: [
          {
            model: models.Collective,
            as: 'collective',
          },
          {
            model: models.Collective,
            as: 'host',
          },
        ],
      });

      if (!virtualCard) {
        throw new NotFound('Could not find Virtual Card');
      }

      if (req.remoteUser.isAdminOfCollective(virtualCard.collective)) {
        await twoFactorAuthLib.enforceForAccount(req, virtualCard.collective);
      } else if (req.remoteUser.isAdminOfCollective(virtualCard.host)) {
        await twoFactorAuthLib.enforceForAccount(req, virtualCard.host);
      } else {
        throw new Unauthorized("You don't have permission to edit this Virtual Card");
      }

      await virtualCard.delete();

      const userCollective = await models.Collective.findByPk(req.remoteUser.CollectiveId);

      await models.Activity.create({
        type: activities.COLLECTIVE_VIRTUAL_CARD_DELETED,
        CollectiveId: virtualCard.collective.id,
        HostCollectiveId: virtualCard.host.id,
        UserId: req.remoteUser.id,
        data: {
          virtualCard: virtualCard.info,
          collective: virtualCard.collective.info,
          host: virtualCard.host.info,
          deletedBy: userCollective.info,
        },
      });

      return true;
    },
  },
};

export default virtualCardMutations;
