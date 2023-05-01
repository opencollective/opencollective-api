import express from 'express';
import { GraphQLNonNull } from 'graphql';
import { GraphQLDateTime, GraphQLNonEmptyString } from 'graphql-scalars';

import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import AgreementModel from '../../../models/Agreement';
import { checkRemoteUserCanUseHost } from '../../common/scope-check';
import { Unauthorized } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { AgreementReferenceInput, fetchAgreementWithReference } from '../input/AgreementReferenceInput';
import { Agreement } from '../object/Agreement';

const agreementMutations = {
  addAgreement: {
    type: new GraphQLNonNull(Agreement),
    description: 'Add an agreement for the given host account. Scope: "host".',
    args: {
      title: {
        type: new GraphQLNonNull(GraphQLNonEmptyString),
        description: 'Agreement title.',
      },
      expiresAt: {
        type: GraphQLDateTime,
        description: 'Optional date in which this agreement expires.',
      },
      host: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Host where the agreement will be created.',
      },
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account that is a party in this agreement',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<AgreementModel> {
      checkRemoteUserCanUseHost(req);

      const host = await fetchAccountWithReference(args.host, {
        throwIfMissing: true,
      });

      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized('Only host admins can create agreements');
      }

      await twoFactorAuthLib.enforceForAccount(req, host);

      const account = await fetchAccountWithReference(args.account, {
        throwIfMissing: true,
      });

      const agreement = await AgreementModel.create({
        title: args.title,
        expiresAt: args.expiresAt,
        HostCollectiveId: host.id,
        CollectiveId: account.id,
        UserId: req.remoteUser.id,
      });

      return agreement;
    },
  },
  editAgreement: {
    type: new GraphQLNonNull(Agreement),
    description: 'Edit an agreement for the given host account. Scope: "host".',
    args: {
      agreement: {
        type: new GraphQLNonNull(AgreementReferenceInput),
        description: 'Agreement to update.',
      },
      title: {
        type: GraphQLNonEmptyString,
        description: 'Host where the agreement will be created.',
      },
      expiresAt: {
        type: GraphQLDateTime,
        description: 'Optional date in which this agreement expires.',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<AgreementModel> {
      checkRemoteUserCanUseHost(req);

      const agreement = await fetchAgreementWithReference(args.agreement, { throwIfMissing: true });
      const host = await agreement.getHost();

      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized('Only host admins can edit agreements');
      }

      await twoFactorAuthLib.enforceForAccount(req, host);

      const toUpdate: Parameters<AgreementModel['update']>[0] = {};

      if (args.title) {
        toUpdate.title = args.title;
      }

      if (args.expiresAt) {
        toUpdate.expiresAt = args.expiresAt;
      }

      return agreement.update(toUpdate);
    },
  },
  deleteAgreement: {
    type: new GraphQLNonNull(Agreement),
    description: 'Delete an agreement for the given host account. Scope: "host".',
    args: {
      agreement: {
        type: new GraphQLNonNull(AgreementReferenceInput),
        description: 'Agreement to delete.',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<AgreementModel> {
      checkRemoteUserCanUseHost(req);

      const agreement = await fetchAgreementWithReference(args.agreement, { throwIfMissing: true });
      const host = await agreement.getHost();

      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized('Only host admins can delete agreements');
      }

      await twoFactorAuthLib.enforceForAccount(req, host);

      await agreement.destroy();
      return agreement;
    },
  },
};

export default agreementMutations;
