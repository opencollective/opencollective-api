import { GraphQLBoolean, GraphQLNonNull } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { Individual } from '../object/Individual';

const individualMutations = {
  setChangelogViewDate: {
    type: new GraphQLNonNull(Individual),
    description: 'Update the time which the user viewed the changelog updates. Scope: "account".',
    args: {
      changelogViewDate: {
        type: new GraphQLNonNull(GraphQLDateTime),
      },
    },
    resolve: async (_, { changelogViewDate }, req) => {
      checkRemoteUserCanUseAccount(req);

      const user = await req.remoteUser.update({ changelogViewDate: changelogViewDate });
      return user.getCollective();
    },
  },
  setNewsletterOptIn: {
    type: new GraphQLNonNull(Individual),
    description: 'Update newsletter opt-in preference. Scope: "account".',
    args: {
      newsletterOptIn: { type: new GraphQLNonNull(GraphQLBoolean) },
    },
    resolve: async (_, { newsletterOptIn }, req) => {
      checkRemoteUserCanUseAccount(req);

      const user = await req.remoteUser.update({ newsletterOptIn });
      return user.getCollective();
    },
  },
};

export default individualMutations;
