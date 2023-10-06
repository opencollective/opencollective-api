import { GraphQLString } from 'graphql';

import models from '../../../models';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import GraphQLUpdate from '../object/Update';

const UpdateQuery = {
  type: GraphQLUpdate,
  args: {
    id: {
      type: GraphQLString,
      description: 'Public identifier',
    },
    slug: {
      type: GraphQLString,
      description: 'The update slug identifying the update',
    },
    account: {
      type: GraphQLAccountReferenceInput,
      description: 'When fetching by slug, an account must be provided',
    },
  },
  async resolve(_, args) {
    if (args.id) {
      return models.Update.findByPk(idDecode(args.id, IDENTIFIER_TYPES.UPDATE));
    } else if (args.account && args.slug) {
      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      return models.Update.findOne({
        where: {
          slug: args.slug.toLowerCase(),
          CollectiveId: account.id,
        },
      });
    } else {
      throw new Error('You must either provide an ID or an account + slug to retrieve an update');
    }
  },
};

export default UpdateQuery;
