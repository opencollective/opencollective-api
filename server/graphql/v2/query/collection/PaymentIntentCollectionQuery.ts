import express from 'express';
import { GraphQLBoolean, GraphQLList, GraphQLNonNull } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { compact, isNil, uniq } from 'lodash';
import { WhereOptions } from 'sequelize';

import { assertCanSeeAllAccounts } from '../../../../lib/private-accounts';
import { Op, sequelize } from '../../../../models';
import PaymentIntent from '../../../../models/PaymentIntent';
import { enforceScope } from '../../../common/scope-check';
import { ValidationFailed } from '../../../errors';
import { GraphQLPaymentIntentCollection } from '../../collection/PaymentIntentCollection';
import { GraphQLPaymentIntentDirection } from '../../enum/PaymentIntentDirection';
import GraphQLPaymentIntentStatus from '../../enum/PaymentIntentStatus';
import GraphQLPaymentIntentType from '../../enum/PaymentIntentType';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

export const PaymentIntentCollectionArgs = {
  limit: { ...CollectionArgs.limit, defaultValue: 100 },
  offset: CollectionArgs.offset,
  host: {
    type: GraphQLAccountReferenceInput,
    description: 'Only return payment intents for this host',
  },
  direction: {
    type: GraphQLPaymentIntentDirection,
    description: 'Filter by direction relative to the account (INCOMING = payee, OUTGOING = payer)',
  },
  includeChildrenPaymentIntents: {
    type: GraphQLBoolean,
    description: 'Include payment intents for child accounts (Events, Projects)',
    defaultValue: false,
  },
  status: {
    type: new GraphQLList(new GraphQLNonNull(GraphQLPaymentIntentStatus)),
    description: 'Filter payment intents by status',
  },
  type: {
    type: new GraphQLList(new GraphQLNonNull(GraphQLPaymentIntentType)),
    description: 'Filter payment intents by type',
  },
  dateFrom: {
    type: GraphQLDateTime,
    description: 'Only return payment intents with an effective date after this date',
  },
  dateTo: {
    type: GraphQLDateTime,
    description: 'Only return payment intents with an effective date before this date',
  },
  counterparty: {
    type: GraphQLAccountReferenceInput,
    description: 'Only return payment intents involving this account as the other party',
  },
};

const buildEffectiveDateFilter = (dateFrom?: Date, dateTo?: Date): WhereOptions[] => {
  const filters: WhereOptions[] = [];
  const effectiveDate = sequelize.fn('COALESCE', sequelize.col('paidAt'), sequelize.col('createdAt'));

  if (dateFrom) {
    filters.push(sequelize.where(effectiveDate, { [Op.gte]: dateFrom }));
  }
  if (dateTo) {
    filters.push(sequelize.where(effectiveDate, { [Op.lte]: dateTo }));
  }

  return filters;
};

const resolveAccountIds = async (
  account: { id: number },
  includeChildren: boolean,
  req: express.Request,
): Promise<number[]> => {
  const accountIds = [account.id];

  if (includeChildren) {
    const childIds = await req.loaders.Collective.childrenIds.load(account.id);
    accountIds.push(...childIds.filter(id => id !== account.id));
  }

  return uniq(accountIds);
};

export const PaymentIntentCollectionResolver = async (
  args,
  req: express.Request,
): Promise<CollectionReturnType<PaymentIntent>> => {
  enforceScope(req, 'transactions');

  if (!args.account && !args.host) {
    throw new ValidationFailed('Either account or host must be provided');
  }

  const account = args.account ? await fetchAccountWithReference(args.account, { throwIfMissing: true }) : null;
  const host = args.host ? await fetchAccountWithReference(args.host, { throwIfMissing: true }) : null;
  const counterparty = args.counterparty
    ? await fetchAccountWithReference(args.counterparty, { throwIfMissing: true })
    : null;

  await assertCanSeeAllAccounts(req, compact([account, host, counterparty]));

  if (isNil(args.limit) || args.limit < 0) {
    args.limit = 100;
  }
  if (isNil(args.offset) || args.offset < 0) {
    args.offset = 0;
  }
  if (args.limit > 1000 && !req.remoteUser?.isRoot()) {
    throw new Error('Cannot fetch more than 1,000 payment intents at the same time, please adjust the limit');
  }

  const where: WhereOptions[] = [];

  if (host) {
    where.push({ HostCollectiveId: host.id });
  }

  if (account) {
    const accountIds = await resolveAccountIds(account, args.includeChildrenPaymentIntents, req);
    const accountConditions: WhereOptions[] = [];

    if (!args.direction || args.direction === 'INCOMING') {
      accountConditions.push({ PayeeCollectiveId: { [Op.in]: accountIds } });
    }
    if (!args.direction || args.direction === 'OUTGOING') {
      accountConditions.push({ PayerCollectiveId: { [Op.in]: accountIds } });
    }

    if (counterparty) {
      where.push({
        [Op.or]: [
          { PayerCollectiveId: { [Op.in]: accountIds }, PayeeCollectiveId: counterparty.id },
          { PayeeCollectiveId: { [Op.in]: accountIds }, PayerCollectiveId: counterparty.id },
        ],
      });
    } else {
      where.push({ [Op.or]: accountConditions });
    }
  }

  if (args.status?.length > 0) {
    where.push({ status: { [Op.in]: args.status } });
  }

  if (args.type?.length > 0) {
    where.push({ type: { [Op.in]: args.type } });
  }

  where.push(...buildEffectiveDateFilter(args.dateFrom, args.dateTo));

  const sequelizeWhere = where.length > 0 ? { [Op.and]: where } : {};

  return {
    nodes: () =>
      PaymentIntent.findAll({
        where: sequelizeWhere,
        limit: args.limit,
        offset: args.offset,
        order: [
          [sequelize.literal('COALESCE("paidAt", "createdAt")'), 'DESC'],
          ['id', 'DESC'],
        ],
      }),
    totalCount: () => PaymentIntent.count({ where: sequelizeWhere }),
    limit: args.limit,
    offset: args.offset,
  };
};

const PaymentIntentCollectionQuery = {
  type: new GraphQLNonNull(GraphQLPaymentIntentCollection),
  description: 'Returns a list of payment intents',
  args: {
    account: {
      type: GraphQLAccountReferenceInput,
      description: 'Filter payment intents involving this account',
    },
    ...PaymentIntentCollectionArgs,
  },
  async resolve(_: void, args, req: express.Request): Promise<CollectionReturnType> {
    return PaymentIntentCollectionResolver(args, req);
  },
};

export default PaymentIntentCollectionQuery;
