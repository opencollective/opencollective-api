import { GraphQLBoolean, GraphQLString } from 'graphql';

import { getGithubHandleFromUrl, getGithubUrlFromHandle } from '../../../lib/github';
import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode } from '../identifiers';
import { Account } from '../interface/Account';

export const buildAccountQuery = ({ objectType }) => ({
  type: objectType,
  args: {
    id: {
      type: GraphQLString,
      description: `The public id identifying the ${objectType.name} (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)`,
    },
    slug: {
      type: GraphQLString,
      description: `The slug identifying the ${objectType.name} (ie: babel for https://opencollective.com/babel)`,
    },
    githubHandle: {
      type: GraphQLString,
      description: `The githubHandle attached to the ${objectType.name} (ie: babel for https://opencollective.com/babel)`,
    },
    throwIfMissing: {
      type: GraphQLBoolean,
      defaultValue: true,
      description: `If false, will return null instead of an error if the ${objectType.name} is not found`,
    },
  },
  async resolve(_, args, req) {
    let collective;
    if (args.slug) {
      const slug = args.slug.toLowerCase();
      collective = await models.Collective.findBySlug(slug, null, args.throwIfMissing);
    } else if (args.id) {
      const id = idDecode(args.id, 'account');
      collective = await req.loaders.Collective.byId.load(id);
    } else if (args.githubHandle) {
      // Try with githubHandle, be it organization/user or repository
      const repositoryUrl = getGithubUrlFromHandle(args.githubHandle);
      if (!repositoryUrl) {
        throw new Error(`Invalid githubHandle: ${args.githubHandle}`);
      }

      collective = await models.Collective.findOne({ where: { repositoryUrl } });
      if (!collective) {
        // If it's a repository, try again with organization/user
        const githubHandle = getGithubHandleFromUrl(repositoryUrl);
        if (githubHandle.includes('/')) {
          const [githubOrg] = githubHandle.split('/');
          collective = await models.Collective.findOne({ where: { githubHandle: githubOrg } });
        }
      }
    } else {
      return new Error('Please provide a slug or an id');
    }

    if (!collective || (objectType.isTypeOf && !objectType.isTypeOf(collective))) {
      if (args.throwIfMissing) {
        throw new NotFound(`${objectType.name} Not Found`);
      } else {
        return null;
      }
    }

    return collective;
  },
});

const AccountQuery = buildAccountQuery({ objectType: Account });

export default AccountQuery;
