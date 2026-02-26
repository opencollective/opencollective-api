import {
  GraphQLBoolean,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';

import { Collective } from '../../../models';
import { GraphQLCurrency } from '../enum/Currency';
import GraphQLURL from '../scalar/URL';

import { GraphQLLocationInput } from './LocationInput';
import { GraphQLSocialLinkInput } from './SocialLinkInput';

export const GraphQLAccountUpdateInput = new GraphQLInputObjectType({
  name: 'AccountUpdateInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The public id identifying the account (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
      deprecationReason: '2026-02-25: use publicId',
    },
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${Collective.nanoIdPrefix}_xxxxxxxx)`,
    },
    name: { type: GraphQLString },
    legalName: { type: GraphQLString },
    slug: { type: GraphQLString },
    description: { type: GraphQLString },
    image: { type: GraphQLURL },
    longDescription: { type: GraphQLString },
    company: { type: GraphQLString },
    tags: { type: new GraphQLList(GraphQLString) },
    location: { type: GraphQLLocationInput },
    socialLinks: { type: new GraphQLList(new GraphQLNonNull(GraphQLSocialLinkInput)) },
    currency: { type: GraphQLCurrency },
    hostFeePercent: {
      type: GraphQLInt,
      description: 'The host fee percentage for this account. Must be between 0 and 100.',
    },
    settings: {
      type: new GraphQLInputObjectType({
        name: 'AccountUpdateSettingsInput',
        fields: () => ({
          apply: {
            type: GraphQLBoolean,
            description: 'Whether this host account is accepting fiscal sponsorship applications.',
          },
          applyMessage: {
            type: GraphQLString,
            description: 'Message shown to users when applying to join this account.',
          },
          tos: { type: GraphQLString, description: 'Terms of Service for this account.' },
          VAT: { type: GraphQLJSON },
          GST: { type: GraphQLJSON },
        }),
      }),
      description: 'Settings for the account.',
    },
    // Event specific fields
    startsAt: {
      description: 'The Event start date and time',
      type: GraphQLDateTime,
    },
    endsAt: {
      description: 'The Event end date and time',
      type: GraphQLDateTime,
    },
    timezone: {
      description: 'Timezone of the Event (TZ database format, e.g. UTC or Europe/Berlin)',
      type: GraphQLString,
      default: 'UTC',
    },
    privateInstructions: {
      type: GraphQLString,
      description: 'Private instructions for the host to be sent to participating users.',
    },
  }),
});
