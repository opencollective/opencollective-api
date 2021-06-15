import { GraphQLInt, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

export const User = new GraphQLObjectType({
  name: 'UserDetails',
  description: 'This represents the details of a User',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(user) {
          return user.id;
        },
      },
      changelogViewDate: {
        type: GraphQLDateTime,
        resolve(user) {
          return user.changelogViewDate;
        },
      },
    };
  },
});
