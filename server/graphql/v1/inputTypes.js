import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLError,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLScalarType,
  GraphQLString,
} from 'graphql';
import { Kind } from 'graphql/language';
import { GraphQLJSON } from 'graphql-scalars';

import { GraphQLSocialLinkInput } from '../v2/input/SocialLinkInput';

import { DateString } from './types';

const EmailType = new GraphQLScalarType({
  name: 'Email',
  serialize: value => {
    return value;
  },
  parseValue: value => {
    return value;
  },
  parseLiteral: ast => {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError(`Query error: Can only parse strings got a: ${ast.kind}`);
    }

    // Regex taken from: http://stackoverflow.com/a/46181/761555
    const re = /^([\w-]+(?:\.[\w-]+)*)@((?:[\w-]+\.)*\w[\w-]{0,66})\.([a-z]{2,6}(?:\.[a-z]{2})?)$/i;
    if (!re.test(ast.value)) {
      throw new GraphQLError(`Query error: Not a valid Email ${[ast]}`);
    }

    return ast.value;
  },
});

const CustomFieldType = new GraphQLEnumType({
  name: 'CustomFieldType',
  description: 'Type of custom field',
  values: {
    number: {},
    text: {},
    email: {},
    date: {},
    radio: {},
    url: {},
  },
});

const CustomFieldsInputType = new GraphQLInputObjectType({
  name: 'CustomFieldsInputType',
  description: 'Input for custom fields for order',
  fields: () => ({
    type: { type: CustomFieldType },
    name: { type: GraphQLString },
    label: { type: GraphQLString },
    required: { type: GraphQLBoolean },
  }),
});

export const StripeCreditCardDataInputType = new GraphQLInputObjectType({
  name: 'StripeCreditCardDataInputType',
  description: 'Input for stripe credit card data',
  fields: () => ({
    fullName: { type: GraphQLString },
    expMonth: { type: GraphQLInt },
    expYear: { type: GraphQLInt },
    brand: { type: GraphQLString },
    country: { type: GraphQLString },
    funding: { type: GraphQLString },
    zip: { type: GraphQLString },
  }),
});

export const UserInputType = new GraphQLInputObjectType({
  name: 'UserInputType',
  description: 'Input type for UserType',
  fields: () => ({
    id: { type: GraphQLInt },
    email: { type: EmailType },
    legalName: { type: GraphQLString },
    name: { type: GraphQLString },
    company: { type: GraphQLString },
    image: { type: GraphQLString },
    description: { type: GraphQLString },
    twitterHandle: { type: GraphQLString, deprecationReason: '2023-01-16: Please use socialLinks' },
    githubHandle: { type: GraphQLString, deprecationReason: '2022-06-03: Please use repositoryUrl' },
    repositoryUrl: { type: GraphQLString, deprecationReason: '2023-01-16: Please use socialLinks' },
    website: { type: GraphQLString, deprecationReason: '2023-01-16: Please use socialLinks' },
    newsletterOptIn: { type: GraphQLBoolean },
    location: { type: LocationInputType },
  }),
});

export const MemberInputType = new GraphQLInputObjectType({
  name: 'MemberInputType',
  description: 'Input type for MemberType',
  fields: () => ({
    id: { type: GraphQLInt },
    member: { type: CollectiveAttributesInputType },
    collective: { type: CollectiveAttributesInputType },
    role: { type: GraphQLString },
    description: { type: GraphQLString },
    since: { type: DateString },
  }),
});

export const NotificationInputType = new GraphQLInputObjectType({
  name: 'NotificationInputType',
  description: 'Input type for NotificationType',
  fields: () => ({
    id: { type: GraphQLInt },
    type: { type: new GraphQLNonNull(GraphQLString) },
    webhookUrl: { type: GraphQLString },
  }),
});

export const CollectiveInputType = new GraphQLInputObjectType({
  name: 'CollectiveInputType',
  description: 'Input type for CollectiveType',
  fields: () => ({
    id: { type: GraphQLInt },
    slug: { type: GraphQLString },
    type: { type: GraphQLString },
    name: { type: GraphQLString },
    legalName: { type: GraphQLString },
    company: { type: GraphQLString },
    website: { type: GraphQLString, deprecationReason: '2023-01-16: Please use socialLinks' },
    twitterHandle: { type: GraphQLString, deprecationReason: '2023-01-16: Please use socialLinks' },
    githubHandle: { type: GraphQLString, deprecationReason: '2022-06-03: Please use repositoryUrl' },
    repositoryUrl: { type: GraphQLString, deprecationReason: '2023-01-16: Please use socialLinks' },
    socialLinks: { type: new GraphQLList(new GraphQLNonNull(GraphQLSocialLinkInput)) },
    description: { type: GraphQLString },
    longDescription: { type: GraphQLString },
    expensePolicy: { type: GraphQLString },
    location: { type: LocationInputType },
    startsAt: { type: GraphQLString },
    endsAt: { type: GraphQLString },
    timezone: { type: GraphQLString },
    currency: { type: GraphQLString },
    image: { type: GraphQLString },
    backgroundImage: { type: GraphQLString },
    tags: { type: new GraphQLList(GraphQLString) },
    tiers: { type: new GraphQLList(TierInputType) },
    settings: { type: GraphQLJSON },
    data: { type: GraphQLJSON, deprecationReason: '2020-10-08: data cannot be edited. This field will be ignored.' },
    privateInstructions: { type: GraphQLString, description: 'Private instructions related to an event' },
    members: { type: new GraphQLList(MemberInputType) },
    notifications: { type: new GraphQLList(NotificationInputType) },
    HostCollectiveId: { type: GraphQLInt },
    hostFeePercent: { type: GraphQLFloat },
    ParentCollectiveId: { type: GraphQLInt },
    // not very logical to have this here. Might need some refactoring. Used to add/edit members and to create a new user on a new order
    email: { type: GraphQLString },
    isIncognito: { type: GraphQLBoolean },
    isActive: { type: GraphQLBoolean },
    contributionPolicy: { type: GraphQLString },
  }),
});

export const ConnectedAccountInputType = new GraphQLInputObjectType({
  name: 'ConnectedAccountInputType',
  description: 'Input type for ConnectedAccountInputType',
  fields: () => ({
    id: { type: GraphQLInt },
    settings: { type: GraphQLJSON },
  }),
});

const CollectiveAttributesInputType = new GraphQLInputObjectType({
  name: 'CollectiveAttributesInputType',
  description: 'Input type for attributes of CollectiveInputType',
  fields: () => ({
    id: { type: GraphQLInt },
    slug: { type: GraphQLString },
    type: { type: GraphQLString },
    name: { type: GraphQLString },
    company: { type: GraphQLString },
    email: { type: GraphQLString }, // for Collective type USER
    description: { type: GraphQLString },
    longDescription: { type: GraphQLString },
    expensePolicy: { type: GraphQLString },
    website: { type: GraphQLString, deprecationReason: '2023-01-16: Please use socialLinks' },
    twitterHandle: { type: GraphQLString, deprecationReason: '2023-01-16: Please use socialLinks' },
    githubHandle: { type: GraphQLString, deprecationReason: '2022-06-03: Please use repositoryUrl' },
    repositoryUrl: { type: GraphQLString, deprecationReason: '2023-01-16: Please use socialLinks' },
    location: { type: LocationInputType },
    startsAt: { type: GraphQLString },
    endsAt: { type: GraphQLString },
    timezone: { type: GraphQLString },
    currency: { type: GraphQLString },
    settings: { type: GraphQLJSON },
    isIncognito: { type: GraphQLBoolean },
    tags: { type: new GraphQLList(GraphQLString) },
    contributionPolicy: { type: GraphQLString },
  }),
});

const LocationInputType = new GraphQLInputObjectType({
  name: 'LocationInputType',
  description: 'Input type for Location',
  fields: () => ({
    name: {
      type: GraphQLString,
      description: 'A short name for the location (eg. Open Collective Headquarters)',
    },
    address: {
      type: GraphQLString,
      description: 'Postal address without country (eg. 12 opensource avenue, 7500 Paris)',
    },
    country: {
      type: GraphQLString,
      description: 'Two letters country code (eg. FR, BE...etc)',
    },
    lat: {
      type: GraphQLFloat,
      description: 'Latitude',
    },
    long: {
      type: GraphQLFloat,
      description: 'Longitude',
    },
    structured: {
      type: GraphQLJSON,
      description: 'Structured JSON address',
    },
  }),
});

export const TierInputType = new GraphQLInputObjectType({
  name: 'TierInputType',
  description: 'Input type for TierType',
  fields: () => ({
    id: { type: GraphQLInt },
    type: { type: GraphQLString },
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    longDescription: {
      type: GraphQLString,
      description: 'A long, html-formatted description.',
    },
    useStandalonePage: {
      type: GraphQLBoolean,
      description: 'Whether this tier has a standalone page',
    },
    videoUrl: {
      type: GraphQLString,
      description: 'Link to a video (YouTube, Vimeo).',
    },
    amount: {
      type: GraphQLInt,
      description: 'amount in the lowest unit of the currency of the host (ie. in cents)',
    },
    button: {
      type: GraphQLString,
      description: 'Button text',
    },
    currency: { type: GraphQLString },
    presets: { type: new GraphQLList(GraphQLInt) },
    interval: { type: GraphQLString },
    maxQuantity: { type: GraphQLInt },
    minimumAmount: { type: GraphQLInt },
    amountType: { type: GraphQLString },
    goal: {
      type: GraphQLInt,
      description: 'amount that you are trying to raise with this tier',
    },
    customFields: { type: new GraphQLList(CustomFieldsInputType) },
    startsAt: {
      type: GraphQLString,
      description: 'Start of the campaign',
    },
    endsAt: {
      type: GraphQLString,
      description: 'End of the campaign',
    },
    invoiceTemplate: {
      type: GraphQLString,
      description: 'Invoice receipt template',
    },
  }),
});
