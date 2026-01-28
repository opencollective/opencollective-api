import express from 'express';
import { GraphQLList, GraphQLNonNull } from 'graphql';
import { isUndefined, omitBy } from 'lodash';
import { Transaction } from 'sequelize';

import sequelize from '../../../lib/sequelize';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models from '../../../models';
import ManualPaymentProviderModel from '../../../models/ManualPaymentProvider';
import { checkRemoteUserCanUseHost } from '../../common/scope-check';
import { Forbidden, Unauthorized, ValidationFailed } from '../../errors';
import { GraphQLManualPaymentProviderType } from '../enum/ManualPaymentProviderType';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import {
  fetchManualPaymentProviderWithReference,
  GraphQLManualPaymentProviderCreateInput,
  GraphQLManualPaymentProviderReferenceInput,
  GraphQLManualPaymentProviderUpdateInput,
} from '../input/ManualPaymentProviderInput';
import { GraphQLManualPaymentProvider } from '../object/ManualPaymentProvider';

const manualPaymentProviderMutations = {
  createManualPaymentProvider: {
    type: new GraphQLNonNull(GraphQLManualPaymentProvider),
    description: 'Create a new manual payment provider for a host. Scope: "host".',
    args: {
      host: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The host to create the manual payment provider for',
      },
      manualPaymentProvider: {
        type: new GraphQLNonNull(GraphQLManualPaymentProviderCreateInput),
        description: 'The manual payment provider data',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<ManualPaymentProviderModel> {
      checkRemoteUserCanUseHost(req);

      const host = await fetchAccountWithReference(args.host, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized("You don't have permission to manage this host");
      }

      // Verify host is actually a host
      if (!host.hasMoneyManagement) {
        throw new ValidationFailed('Only hosts can have manual payment providers');
      }

      // Enforce 2FA
      await twoFactorAuthLib.enforceForAccount(req, host);

      // Get max order to place new provider at the end
      return sequelize.transaction(async (transaction: Transaction) => {
        const maxOrder: number | null = await models.ManualPaymentProvider.max('order', {
          where: { CollectiveId: host.id },
        });

        return models.ManualPaymentProvider.create(
          {
            CollectiveId: host.id,
            type: args.manualPaymentProvider.type,
            name: args.manualPaymentProvider.name,
            instructions: args.manualPaymentProvider.instructions,
            icon: args.manualPaymentProvider.icon,
            data: args.manualPaymentProvider.accountDetails,
            order: (maxOrder || 0) + 1,
          },
          { transaction },
        );
      });
    },
  },
  updateManualPaymentProvider: {
    type: new GraphQLNonNull(GraphQLManualPaymentProvider),
    description: 'Update an existing manual payment provider. Scope: "host".',
    args: {
      manualPaymentProvider: {
        type: new GraphQLNonNull(GraphQLManualPaymentProviderReferenceInput),
        description: 'Reference to the manual payment provider to update',
      },
      input: {
        type: new GraphQLNonNull(GraphQLManualPaymentProviderUpdateInput),
        description: 'The updated fields',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<ManualPaymentProviderModel> {
      checkRemoteUserCanUseHost(req);

      const provider = await fetchManualPaymentProviderWithReference(args.manualPaymentProvider, {
        loaders: req.loaders,
        throwIfMissing: true,
      });

      const host = await req.loaders.Collective.byId.load(provider.CollectiveId);
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Forbidden("You don't have permission to manage this host");
      }

      if (provider.archivedAt) {
        throw new ValidationFailed('Cannot update an archived manual payment provider');
      }

      // Enforce 2FA
      await twoFactorAuthLib.enforceForAccount(req, host);
      return provider.update(
        omitBy(
          {
            name: args.input.name,
            instructions: args.input.instructions,
            icon: args.input.icon,
            data: args.input.accountDetails,
          },
          isUndefined,
        ),
      );
    },
  },

  deleteManualPaymentProvider: {
    type: new GraphQLNonNull(GraphQLManualPaymentProvider),
    description:
      'Delete a manual payment provider. If orders reference this provider, it will be archived instead. Scope: "host".',
    args: {
      manualPaymentProvider: {
        type: new GraphQLNonNull(GraphQLManualPaymentProviderReferenceInput),
        description: 'Reference to the manual payment provider to delete',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<ManualPaymentProviderModel> {
      checkRemoteUserCanUseHost(req);

      const provider = await fetchManualPaymentProviderWithReference(args.manualPaymentProvider, {
        loaders: req.loaders,
        throwIfMissing: true,
      });

      const host = await req.loaders.Collective.byId.load(provider.CollectiveId);
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Forbidden("You don't have permission to manage this host");
      }

      // Check if provider can be deleted or should be archived
      return sequelize.transaction(async (transaction: Transaction) => {
        if (await provider.canBeDeleted({ transaction })) {
          await twoFactorAuthLib.enforceForAccount(req, host);
          await provider.destroy({ transaction });
          return provider;
        } else {
          // Archive instead of delete if orders reference this provider
          await twoFactorAuthLib.enforceForAccount(req, host, { alwaysAskForToken: true });
          return provider.archive({ transaction });
        }
      });
    },
  },

  reorderManualPaymentProviders: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLManualPaymentProvider))),
    description: 'Reorder manual payment providers for a host. Scope: "host".',
    args: {
      host: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The host to reorder manual payment providers for',
      },
      type: {
        type: new GraphQLNonNull(GraphQLManualPaymentProviderType),
        description: 'The type of providers to reorder',
      },
      providers: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLManualPaymentProviderReferenceInput))),
        description: 'Ordered list of provider IDs',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<ManualPaymentProviderModel[]> {
      checkRemoteUserCanUseHost(req);

      const host = await fetchAccountWithReference(args.host, { loaders: req.loaders, throwIfMissing: true });

      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Forbidden("You don't have permission to manage this host");
      }

      // Decode all provider IDs
      const providers = await Promise.all(
        args.providers.map(async provider =>
          fetchManualPaymentProviderWithReference(provider, { loaders: req.loaders, throwIfMissing: true }),
        ),
      );

      // Update order for each provider
      return sequelize.transaction(async (transaction: Transaction) => {
        return Promise.all(
          providers.map(async (provider, idx) => {
            if (idx !== provider.order) {
              await provider.update({ order: idx }, { transaction });
            }

            return provider;
          }),
        );
      });
    },
  },
};
export default manualPaymentProviderMutations;
