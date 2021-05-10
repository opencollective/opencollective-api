/* eslint-disable camelcase */
import express from 'express';
import { GraphQLBoolean, GraphQLNonNull, GraphQLString } from 'graphql';

import { activities } from '../../../constants';
import models from '../../../models';
import VirtualCardModel from '../../../models/VirtualCard';
import privacy from '../../../paymentProviders/privacy';
import { BadRequest, NotFound, Unauthorized } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { VirtualCardInput } from '../input/VirtualCardInput';
import { VirtualCardReferenceInput } from '../input/VirtualCardReferenceInput';
import { VirtualCard } from '../object/VirtualCard';

const virtualCardMutations = {
  assignNewVirtualCard: {
    description: 'Assign new Virtual Card information to existing hosted collective',
    type: new GraphQLNonNull(VirtualCard),
    args: {
      virtualCard: {
        type: new GraphQLNonNull(VirtualCardInput),
        description: 'Virtual Card data',
      },
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account where the virtual card will be associated',
      },
      userAccount: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'User account responsible for the card',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<VirtualCardModel> {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to assign a virtual card');
      }

      const collective = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      const host = await collective.getHostCollective();
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized("You don't have permission to edit this collective");
      }
      const userCollective = await fetchAccountWithReference(args.userAccount, {
        loaders: req.loaders,
      });

      const { cardNumber, expireDate, cvv } = args.virtualCard.privateData;
      if (!cardNumber || !expireDate || !cvv) {
        throw new BadRequest('VirtualCard missing cardNumber, expireDate and/or cvv', undefined, {
          cardNumber: !cardNumber && 'Card Number is required',
          expireDate: !expireDate && 'Expire Date is required',
          cvv: !cvv && 'CVV is required',
        });
      }

      return privacy.assignCardToCollective({ cardNumber, expireDate, cvv }, collective, host, {
        UserId: userCollective.CreatedByUserId,
      });
    },
  },
  requestVirtualCard: {
    description: 'Request Virtual Card to host',
    type: GraphQLBoolean,
    args: {
      notes: {
        type: GraphQLString,
        description: 'Request notes',
      },
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account where the virtual card will be associated',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<boolean> {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to request a virtual card');
      }
      const collective = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Unauthorized("You don't have permission to request a virtual card for this collective");
      }

      const host = await collective.getHostCollective();
      const activity = {
        type: activities.VIRTUAL_CARD_REQUESTED,
        UserId: req.remoteUser.id,
        data: {
          host: host.activity,
          collective: collective.activity,
          user: req.remoteUser.info,
          notes: args.notes,
        },
      };

      await models.Activity.create(activity);

      return true;
    },
  },
  pauseVirtualCard: {
    description: 'Pause active Virtual Card',
    type: new GraphQLNonNull(VirtualCard),
    args: {
      virtualCard: {
        type: new GraphQLNonNull(VirtualCardReferenceInput),
        description: 'Virtual Card reference',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<VirtualCardModel> {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to assign a Virtual Card');
      }

      const virtualCard = await models.VirtualCard.findOne({ where: { id: args.virtualCard.id } });
      if (!virtualCard) {
        throw new NotFound('Could not find Virtual Card');
      }

      if (!req.remoteUser.isAdmin(virtualCard.HostCollectiveId)) {
        throw new Unauthorized("You don't have permission to edit this Virtual Card");
      }

      return privacy.pauseCard(virtualCard);
    },
  },
  resumeVirtualCard: {
    description: 'Resume paused Virtual Card',
    type: new GraphQLNonNull(VirtualCard),
    args: {
      virtualCard: {
        type: new GraphQLNonNull(VirtualCardReferenceInput),
        description: 'Virtual Card reference',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<VirtualCardModel> {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to assign a Virtual Card');
      }

      const virtualCard = await models.VirtualCard.findOne({ where: { id: args.virtualCard.id } });
      if (!virtualCard) {
        throw new NotFound('Could not find Virtual Card');
      }

      if (!req.remoteUser.isAdmin(virtualCard.HostCollectiveId)) {
        throw new Unauthorized("You don't have permission to edit this Virtual Card");
      }

      return privacy.resumeCard(virtualCard);
    },
  },
  deleteVirtualCard: {
    description: 'Delete Virtual Card',
    type: GraphQLBoolean,
    args: {
      virtualCard: {
        type: new GraphQLNonNull(VirtualCardReferenceInput),
        description: 'Virtual Card reference',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<boolean> {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to assign a Virtual Card');
      }

      const virtualCard = await models.VirtualCard.findOne({ where: { id: args.virtualCard.id } });
      if (!virtualCard) {
        throw new NotFound('Could not find Virtual Card');
      }

      if (!req.remoteUser.isAdmin(virtualCard.HostCollectiveId)) {
        throw new Unauthorized("You don't have permission to edit this Virtual Card");
      }

      await privacy.deleteCard(virtualCard);
      return true;
    },
  },
};

export default virtualCardMutations;
