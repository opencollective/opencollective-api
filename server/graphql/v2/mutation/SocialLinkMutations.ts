import express from 'express';
import { GraphQLFieldConfigMap, GraphQLList, GraphQLNonNull } from 'graphql';

import { default as SocialLinkModel } from '../../../models/SocialLink.js';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check.js';
import { Unauthorized } from '../../errors.js';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput.js';
import { GraphQLSocialLinkInput } from '../input/SocialLinkInput.js';
import { GraphQLSocialLink } from '../object/SocialLink.js';

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
