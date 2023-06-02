import express from 'express';
import { GraphQLFieldConfigMap, GraphQLList, GraphQLNonNull } from 'graphql';

import type { default as SocialLinkModel } from '../../../models/SocialLink';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { Unauthorized } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLSocialLinkInput } from '../input/SocialLinkInput';
import { GraphQLSocialLink } from '../object/SocialLink';

const socialLinkMutations: GraphQLFieldConfigMap<void, express.Request> = {
  updateSocialLinks: {
    description: 'Updates collective social links',
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLSocialLink))),
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account where the social link will be associated',
      },
      socialLinks: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLSocialLinkInput))),
        description: 'The social links in order of preference',
      },
    },
    async resolve(context, args, req): Promise<SocialLinkModel[]> {
      checkRemoteUserCanUseAccount(req);

      const account = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });

      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Unauthorized("You don't have permission to edit this collective");
      }

      return await account.updateSocialLinks(args.socialLinks);
    },
  },
};

export default socialLinkMutations;
