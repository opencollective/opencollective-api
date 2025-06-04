import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLLocale } from 'graphql-scalars';

import PlatformConstants from '../../../constants/platform';
import {
  createGoCardlessAgreement,
  createGoCardlessRequisition,
  listGoCardlessInstitutions,
} from '../../../lib/gocardless/connect';
import RateLimit from '../../../lib/rate-limit';
import { checkRemoteUserCanUseTransactions } from '../../common/scope-check';
import { Forbidden, RateLimitExceeded } from '../../errors';
import { GraphQLCountryISO } from '../enum';

const GraphQLGoCardlessInstitution = new GraphQLObjectType({
  name: 'GoCardlessInstitution',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    bic: { type: GraphQLString },
    logo: { type: GraphQLString },
    countries: { type: new GraphQLList(GraphQLString) },
  },
});

const GraphQLGoCardlessRequisitionResponse = new GraphQLObjectType({
  name: 'GoCardlessRequisitionResponse',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    link: { type: new GraphQLNonNull(GraphQLString) },
    status: { type: GraphQLString },
    accounts: { type: new GraphQLList(GraphQLString) },
  },
});

export const goCardlessMutations = {
  listGoCardlessInstitutions: {
    type: new GraphQLList(GraphQLGoCardlessInstitution),
    description: 'List available GoCardless institutions for a country',
    args: {
      country: { type: new GraphQLNonNull(GraphQLCountryISO) },
    },
    resolve: async (_, args, req: Express.Request) => {
      checkRemoteUserCanUseTransactions(req);
      const allowedIds = [
        ...PlatformConstants.FirstPartyHostCollectiveIds,
        ...PlatformConstants.AllPlatformCollectiveIds,
        PlatformConstants.OCICollectiveId,
      ];
      if (!req.remoteUser.isRoot() && !allowedIds.some(id => req.remoteUser.isAdmin(id))) {
        throw new Forbidden('You do not have permission to list GoCardless institutions');
      }
      const rateLimiter = new RateLimit(`listGoCardlessInstitutions:${req.remoteUser.id}`, 10, 60);
      if (!(await rateLimiter.registerCall())) {
        throw new RateLimitExceeded('Please wait a few minutes before trying again.');
      }
      const result = await listGoCardlessInstitutions(args.country);
      return result.institutions || result;
    },
  },
  createGoCardlessAgreement: {
    type: GraphQLString,
    description: 'Create a GoCardless end user agreement',
    args: {
      institutionId: { type: new GraphQLNonNull(GraphQLString) },
      maxHistoricalDays: { type: GraphQLString },
      accessValidForDays: { type: GraphQLString },
      accessScope: { type: new GraphQLList(GraphQLString) },
    },
    resolve: async (_, args, req: Express.Request) => {
      checkRemoteUserCanUseTransactions(req);
      const allowedIds = [
        ...PlatformConstants.FirstPartyHostCollectiveIds,
        ...PlatformConstants.AllPlatformCollectiveIds,
        PlatformConstants.OCICollectiveId,
      ];
      if (!req.remoteUser.isRoot() && !allowedIds.some(id => req.remoteUser.isAdmin(id))) {
        throw new Forbidden('You do not have permission to create a GoCardless agreement');
      }
      const rateLimiter = new RateLimit(`createGoCardlessAgreement:${req.remoteUser.id}`, 10, 60);
      if (!(await rateLimiter.registerCall())) {
        throw new RateLimitExceeded('Please wait a few minutes before trying again.');
      }
      const agreement = await createGoCardlessAgreement(args.institutionId, {
        ['max_historical_days']: args.maxHistoricalDays,
        ['access_valid_for_days']: args.accessValidForDays,
        ['access_scope']: args.accessScope,
      });
      return agreement.id;
    },
  },
  createGoCardlessRequisition: {
    type: GraphQLGoCardlessRequisitionResponse,
    description: 'Create a GoCardless requisition (link for user authentication)',
    args: {
      institutionId: { type: new GraphQLNonNull(GraphQLString) },
      redirect: { type: new GraphQLNonNull(GraphQLString) },
      reference: { type: new GraphQLNonNull(GraphQLString) },
      agreementId: { type: GraphQLString },
      userLanguage: { type: GraphQLLocale },
    },
    resolve: async (_, args, req: Express.Request) => {
      checkRemoteUserCanUseTransactions(req);
      const allowedIds = [
        ...PlatformConstants.FirstPartyHostCollectiveIds,
        ...PlatformConstants.AllPlatformCollectiveIds,
        PlatformConstants.OCICollectiveId,
      ];
      if (!req.remoteUser.isRoot() && !allowedIds.some(id => req.remoteUser.isAdmin(id))) {
        throw new Forbidden('You do not have permission to create a GoCardless requisition');
      }
      const rateLimiter = new RateLimit(`createGoCardlessRequisition:${req.remoteUser.id}`, 10, 60);
      if (!(await rateLimiter.registerCall())) {
        throw new RateLimitExceeded('Please wait a few minutes before trying again.');
      }
      const requisition = await createGoCardlessRequisition(args);
      return {
        id: requisition.id,
        link: requisition.link,
        status: requisition.status,
        accounts: requisition.accounts,
      };
    },
  },
};
