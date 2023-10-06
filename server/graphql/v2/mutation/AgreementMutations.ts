import express from 'express';
import { GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLNonEmptyString } from 'graphql-scalars';
import GraphQLUpload from 'graphql-upload/GraphQLUpload.js';
import type { FileUpload } from 'graphql-upload/Upload.js';
import { pick } from 'lodash';

import ActivityTypes from '../../../constants/activities';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import { Activity, UploadedFile } from '../../../models';
import AgreementModel from '../../../models/Agreement';
import { checkRemoteUserCanUseHost } from '../../common/scope-check';
import { Unauthorized } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { fetchAgreementWithReference, GraphQLAgreementReferenceInput } from '../input/AgreementReferenceInput';
import { GraphQLAgreement } from '../object/Agreement';

export default {
  addAgreement: {
    type: new GraphQLNonNull(GraphQLAgreement),
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
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Host where the agreement will be created.',
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account that is a party in this agreement',
      },
      attachment: {
        type: GraphQLUpload,
        description: 'Agreement attachment',
      },
      notes: {
        type: GraphQLString,
        description: 'Additional notes about the agreement for the host admins',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<AgreementModel> {
      checkRemoteUserCanUseHost(req);

      const host = await fetchAccountWithReference(args.host, {
        throwIfMissing: true,
      });

      const account = await fetchAccountWithReference(args.account, {
        throwIfMissing: true,
      });

      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized('Only host admins can create agreements');
      } else if (account.HostCollectiveId !== host.id) {
        // We're not checking `isActive` as it should be possible to create agreements for accounts not approved yet
        throw new Unauthorized(`Account ${account.name} is not currently hosted by ${host.name}`);
      }

      await twoFactorAuthLib.enforceForAccount(req, host);

      const attachment: Promise<FileUpload> = args.attachment;

      let uploadedFile;
      if (attachment) {
        uploadedFile = await UploadedFile.uploadGraphQl(await attachment, 'AGREEMENT_ATTACHMENT', req.remoteUser);
      }

      const agreement = await AgreementModel.create({
        title: args.title,
        notes: args.notes,
        expiresAt: args.expiresAt,
        HostCollectiveId: host.id,
        CollectiveId: account.id,
        UserId: req.remoteUser.id,
        UploadedFileId: uploadedFile?.id,
      });

      await Activity.create({
        type: ActivityTypes.AGREEMENT_CREATED,
        UserId: req.remoteUser.id,
        UserTokenId: req.userToken?.id,
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        data: {
          agreement: agreement.info,
          collective: account.info,
          host: host.info,
          user: req.remoteUser.info,
        },
      });

      return agreement;
    },
  },
  editAgreement: {
    type: new GraphQLNonNull(GraphQLAgreement),
    description: 'Edit an agreement for the given host account. Scope: "host".',
    args: {
      agreement: {
        type: new GraphQLNonNull(GraphQLAgreementReferenceInput),
        description: 'Agreement to update.',
      },
      title: {
        type: GraphQLNonEmptyString,
        description: 'Updated agreement title',
      },
      expiresAt: {
        type: GraphQLDateTime,
        description: 'Optional date in which this agreement expires.',
      },
      attachment: {
        type: GraphQLUpload,
        description: 'Agreement attachment',
      },
      notes: {
        type: GraphQLString,
        description: 'Additional notes about the agreement for the host admins',
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

      const toUpdate: Parameters<AgreementModel['update']>[0] = pick(args, ['notes', 'title', 'expiresAt']);
      const attachment: Promise<FileUpload> = args.attachment;
      if (attachment !== undefined) {
        const file = await attachment;
        if (file === null) {
          toUpdate.UploadedFileId = null;
        } else {
          const uploadedFile = await UploadedFile.uploadGraphQl(file, 'AGREEMENT_ATTACHMENT', req.remoteUser);
          toUpdate.UploadedFileId = uploadedFile.id;
        }
      }

      const updatedAgreement = await agreement.update(toUpdate);

      await Activity.create({
        type: ActivityTypes.AGREEMENT_EDITED,
        UserId: req.remoteUser.id,
        UserTokenId: req.userToken?.id,
        CollectiveId: updatedAgreement.CollectiveId,
        HostCollectiveId: host.id,
        data: {
          agreement: updatedAgreement.info,
          collective: (await agreement.getCollective()).info,
          host: host.info,
          user: req.remoteUser.info,
        },
      });

      return updatedAgreement;
    },
  },
  deleteAgreement: {
    type: new GraphQLNonNull(GraphQLAgreement),
    description: 'Delete an agreement for the given host account. Scope: "host".',
    args: {
      agreement: {
        type: new GraphQLNonNull(GraphQLAgreementReferenceInput),
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

      await Activity.create({
        type: ActivityTypes.AGREEMENT_DELETED,
        UserId: req.remoteUser.id,
        UserTokenId: req.userToken?.id,
        CollectiveId: agreement.CollectiveId,
        HostCollectiveId: host.id,
        data: {
          agreement: agreement.info,
          collective: (await agreement.getCollective()).info,
          host: host.info,
          user: req.remoteUser.info,
        },
      });

      return agreement;
    },
  },
};
