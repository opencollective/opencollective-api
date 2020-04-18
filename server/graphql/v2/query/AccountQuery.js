import { GraphQLBoolean, GraphQLString } from 'graphql';

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
  async resolve(_, args) {
    let collective;
    if (args.slug) {
      const slug = args.slug.toLowerCase();
      collective = await models.Collective.findBySlug(slug, null, args.throwIfMissing);
    } else if (args.id) {
      const id = idDecode(args.id, 'account');
      collective = await models.Collective.findByPk(id);
    } else if (args.githubHandle) {
      // Try with githubHandle, be it organization/user or repository
      collective = await models.Collective.findOne({ where: { githubHandle: args.githubHandle } });
      if (!collective && args.githubHandle.includes('/')) {
        // If it's a repository, try again with organization/user
        const [githubOrg] = args.githubHandle.split('/');
        collective = await models.Collective.findOne({ where: { githubHandle: githubOrg } });
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
