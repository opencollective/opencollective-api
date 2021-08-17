import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { AccountType, MemberRole } from '../enum';
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

const MemberOfCollectionRole = new GraphQLObjectType({
  name: 'MemberOfCollectionRoles',
  description: 'An existing member role and account type combination used used to filter collections',
  fields: () => {
    return {
      type: {
        type: new GraphQLNonNull(AccountType),
      },
      role: {
        type: new GraphQLNonNull(MemberRole),
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
      roles: {
        type: new GraphQLList(MemberOfCollectionRole),
      },
    };
  },
});
