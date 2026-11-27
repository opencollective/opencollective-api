import type express from 'express';
import { GraphQLBoolean, GraphQLNonNull } from 'graphql';
import { compact, uniq } from 'lodash';
import moment from 'moment';

import ActivityTypes from '../../../constants/activities';
import { CollectiveType } from '../../../constants/collectives';
import { type AddressPart, sendManualContributorInfoRequest } from '../../../lib/contributor-info-notify';
import { Activity, Op, Transaction } from '../../../models';
import { checkRemoteUserCanUseHost } from '../../common/scope-check';
import { BadRequest, RateLimitExceeded, Unauthorized, ValidationFailed } from '../../errors';
import { fetchAccountWithReference } from '../input/AccountReferenceInput';
import { GraphQLRequestContributorInfoInput } from '../input/RequestContributorInfoInput';

const MESSAGE_MAX_LENGTH = 1000;

/** One manual request per host and account during this period */
const RATE_LIMIT_HOURS = 24;

const contributorInfoMutations = {
  requestContributorInfo: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Email an individual or organization to add or correct its legal name and/or address. Scope: "host".',
    args: {
      input: {
        type: new GraphQLNonNull(GraphQLRequestContributorInfoInput),
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<boolean> {
      checkRemoteUserCanUseHost(req);

      const { input } = args;
      const host = await fetchAccountWithReference(input.host, { loaders: req.loaders, throwIfMissing: true });
      const account = await fetchAccountWithReference(input.account, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized('Only host admins can request contributor information');
      } else if (!(await host.isHost())) {
        throw new BadRequest('Only fiscal hosts can request contributor information');
      } else if (![CollectiveType.USER, CollectiveType.ORGANIZATION].includes(account.type) || account.isIncognito) {
        throw new BadRequest('Information can only be requested from individuals and organizations');
      }

      const fields = uniq(input.fields as ('legalName' | 'address')[]);
      const addressParts = uniq((input.addressFields || []) as AddressPart[]);
      const message = input.message?.trim() || null;
      if (!fields.length) {
        throw new ValidationFailed('Select at least one field to request');
      } else if (addressParts.length && !fields.includes('address')) {
        throw new ValidationFailed('Address fields can only be requested with the address');
      } else if (message && message.length > MESSAGE_MAX_LENGTH) {
        throw new ValidationFailed(`Message is too long (maximum ${MESSAGE_MAX_LENGTH} characters)`);
      }

      // The account must have contributed to, or been paid by, one of the host's collectives
      const incognitoProfile = account.type === CollectiveType.USER ? await account.getIncognitoProfile() : null;
      const accountIds = compact([account.id, incognitoProfile?.id]);
      const transaction = await Transaction.findOne({
        attributes: ['id'],
        where: {
          HostCollectiveId: host.id,
          [Op.or]: [{ FromCollectiveId: accountIds }, { CollectiveId: accountIds }],
        },
      });
      if (!transaction) {
        throw new BadRequest('This account has no transactions with your fiscal host');
      }

      const recentRequest = await Activity.findOne({
        attributes: ['id'],
        where: {
          type: ActivityTypes.CONTRIBUTOR_INFO_REQUESTED,
          CollectiveId: account.id,
          HostCollectiveId: host.id,
          createdAt: { [Op.gte]: moment().subtract(RATE_LIMIT_HOURS, 'hours').toDate() },
        },
      });
      if (recentRequest) {
        throw new RateLimitExceeded(
          `Information was already requested from this account in the last ${RATE_LIMIT_HOURS} hours`,
        );
      }

      const result = await sendManualContributorInfoRequest({
        host,
        profile: account,
        fields,
        addressParts,
        message,
        requestedBy: req.remoteUser,
      });
      if (!result.recipients) {
        throw new BadRequest('This account has no admin with an email address');
      } else if (!result.sentTo.length) {
        throw new Error('The email could not be sent, please try again later');
      }

      return true;
    },
  },
};

export default contributorInfoMutations;
