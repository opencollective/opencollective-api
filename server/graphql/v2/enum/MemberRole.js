import { GraphQLEnumType } from 'graphql';

export const GraphQLMemberRole = new GraphQLEnumType({
  name: 'MemberRole',
  description: 'All member roles',
  values: {
    BACKER: {},
    ADMIN: {},
    CONTRIBUTOR: {},
    HOST: {},
    ATTENDEE: {},
    MEMBER: {},
    FUNDRAISER: { deprecationReason: '2022-09-12: This role does not exist anymore' },
    FOLLOWER: {},
    ACCOUNTANT: {},
    CONNECTED_ACCOUNT: { value: 'CONNECTED_COLLECTIVE' },
  },
});
