import { GraphQLList, GraphQLObjectType } from 'graphql';

import { Collection, CollectionFields } from '../interface/Collection';
import { Member, MemberOf } from '../object/Member';

export const MemberCollection = new GraphQLObjectType({
  name: 'MemberCollection',
  interfaces: [Collection],
  description: 'A collection of "Members" (ie: Organization backing a Collective)',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(Member),
      },
    };
  },
});

export const MemberOfCollection = new GraphQLObjectType({
  name: 'MemberOfCollection',
  interfaces: [Collection],
  description: 'A collection of "MemberOf" (ie: Collective backed by an Organization)',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(MemberOf),
      },
    };
  },
});
