import {
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLInputObjectType
} from 'graphql';

export const UserInputType = new GraphQLInputObjectType({
  name: 'UserInputType',
  description: 'Input type for UserType',
  fields: () => ({
    id: { type: GraphQLInt},
    email: { type: GraphQLString },
    firstName: { type: GraphQLString },
    lastName: { type: GraphQLString }
  })
});

export const GroupInputType = new GraphQLInputObjectType({
  name: 'GroupInputType',
  description: 'Input type for GroupType',
  fields: () => ({
    id:   { type: GraphQLInt },
    slug: { type: new GraphQLNonNull(GraphQLString) }
  })
});

export const EventAttributesInputType = new GraphQLInputObjectType({
  name: 'EventAttributes',
  description: 'Input type for attributes of EventInputType',
  fields: () => ({
    id: { type: GraphQLInt },
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    locationString: { type: GraphQLString },
    startsAt: { type: GraphQLString },
    endsAt: { type: GraphQLString },
    maxAmount: { type: GraphQLInt },
    currency: { type: GraphQLString},
  })
});

export const EventInputType = new GraphQLInputObjectType({
  name: 'EventInputType',
  description: 'Input type for EventType',
  fields: () => ({
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: new GraphQLNonNull(GraphQLString) },
    locationString: { type: GraphQLString },
    startsAt: { type: new GraphQLNonNull(GraphQLString) },
    endsAt: { type: GraphQLString },
    maxAmount: { type: new GraphQLNonNull(GraphQLString) },
    currency: { type: GraphQLString },
    quantity: { type: GraphQLInt },
    tiers: { type: new GraphQLList(TierInputType) },
    group: { type: new GraphQLNonNull(GroupInputType) },
  })
});

export const TierInputType = new GraphQLInputObjectType({
  name: 'TierInputType',
  description: 'Input type for TierType',
  fields: () => ({
    id: { type: GraphQLInt },
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    amount: { type: GraphQLInt },
    currency: { type: GraphQLString },
    quantity: { type: GraphQLInt },
    password: { type: GraphQLString },
    startsAt: { type: GraphQLString },
    endsAt: { type: GraphQLString },
  })
});


export const ResponseInputType = new GraphQLInputObjectType({
  name: 'ResponseInputType',
  description: 'Input type for ResponseType',
  fields: () => ({
    id: { type: GraphQLInt },
    quantity: { type: new GraphQLNonNull(GraphQLInt) },
    user: { type: new GraphQLNonNull(UserInputType) },
    group: { type: new GraphQLNonNull(GroupInputType) },
    tier: { type: new GraphQLNonNull(TierInputType) },
    event: { type: new GraphQLNonNull(EventAttributesInputType) },
    status: { type: new GraphQLNonNull(GraphQLString) },
  })
})