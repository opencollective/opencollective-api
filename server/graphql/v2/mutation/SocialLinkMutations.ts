import express from 'express';
import { GraphQLFieldConfigMap, GraphQLList, GraphQLNonNull } from 'graphql';

import type { default as SocialLinkModel } from '../../../models/SocialLink';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { Unauthorized } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { SocialLinkInput } from '../input/SocialLinkInput';
import { SocialLink } from '../object/SocialLink';

const socialLinkMutations: GraphQLFieldConfigMap<void, express.Request> = {
  updateSocialLinks: {
    description: 'Updates collective social links',
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SocialLink))),
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account where the social link will be associated',
      },
      socialLinks: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SocialLinkInput))),
        description: 'The social links in order of preference',
      },
    },
    async resolve(context, args, req): Promise<SocialLinkModel[]> {
      checkRemoteUserCanUseAccount(req);

      const account = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });

      if (!req.remoteUser.isAdmin(account.id)) {
        throw new Unauthorized("You don't have permission to edit this collective");
      }

      return await account.updateSocialLinks(args.socialLinks);
    },
  },
};

export default socialLinkMutations;
