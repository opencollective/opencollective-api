import { GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { GraphQLJSON } from 'graphql-scalars';

export const EventCreateInput = new GraphQLInputObjectType({
  name: 'EventCreateInput',
  fields: () => ({
    name: { type: new GraphQLNonNull(GraphQLString) },
    slug: { type: GraphQLString },
    description: { type: GraphQLString },
    tags: { type: new GraphQLList(GraphQLString) },
    settings: { type: GraphQLJSON },
    startsAt: {
      description: 'The Event start date and time',
      type: new GraphQLNonNull(GraphQLDateTime),
    },
    endsAt: {
      description: 'The Event end date and time',
      type: new GraphQLNonNull(GraphQLDateTime),
    },
    timezone: {
      description: 'Timezone of the Event (TZ database format, e.g. UTC or Europe/Berlin)',
      type: new GraphQLNonNull(GraphQLString),
      default: 'UTC',
    },
  }),
});
