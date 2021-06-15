import { GraphQLNonNull } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date/dist';

import { Unauthorized, ValidationFailed } from '../../errors';
import { User } from '../object/User';

const userMutations = {
  setChangelogViewDate: {
    type: new GraphQLNonNull(User),
    description: 'Update the time which the user viewed the changelog updates',
    args: {
      changelogViewDate: {
        type: new GraphQLNonNull(GraphQLDateTime),
      },
    },
    resolve: (_, { changelogViewDate }, { remoteUser }) => {
      if (!remoteUser) {
        throw new Unauthorized();
      } else if (!changelogViewDate) {
        throw new ValidationFailed('The change log view date must be set');
      }
      const date = new Date(changelogViewDate);
      return remoteUser.update({ changelogViewDate: date });
    },
  },
};

export default userMutations;
