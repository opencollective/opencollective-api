import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { GraphQLAccountType, GraphQLMemberRole } from '../enum';
import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLMember, GraphQLMemberOf } from '../object/Member';

export const GraphQLMemberCollection = new GraphQLObjectType({
  name: 'MemberCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "Members" (ie: Organization backing a Collective)',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(GraphQLMember),
      },
    };
  },
});

const GraphQLMemberOfCollectionRole = new GraphQLObjectType({
  name: 'MemberOfCollectionRoles',
  description: 'An existing member role and account type combination used used to filter collections',
  fields: () => {
    return {
      type: {
        type: new GraphQLNonNull(GraphQLAccountType),
      },
      role: {
        type: new GraphQLNonNull(GraphQLMemberRole),
      },
    };
  },
});

export const GraphQLMemberOfCollection = new GraphQLObjectType({
  name: 'MemberOfCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "MemberOf" (ie: Collective backed by an Organization)',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(GraphQLMemberOf),
      },
      roles: {
        type: new GraphQLList(GraphQLMemberOfCollectionRole),
      },
    };
  },
});
