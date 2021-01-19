import { GraphQLString } from 'graphql';

import models from '../../../models';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import Update from '../object/Update';

const UpdateQuery = {
  type: Update,
  args: {
    id: {
      type: GraphQLString,
      description: 'Public identifier',
    },
    updateSlug: {
      type: GraphQLString,
      description: 'The update slug identifying the update',
      deprecationReason: '2020-01-19: Please use `slug`',
    },
    slug: {
      type: GraphQLString,
      description: 'The update slug identifying the update',
    },
    account: {
      type: AccountReferenceInput,
      description: 'When fetching by slug, an account must be provided',
    },
  },
  async resolve(_, args) {
    if (args.id) {
      return models.Update.findByPk(idDecode(args.id, IDENTIFIER_TYPES.UPDATE));
    } else if (args.updateSlug) {
      // @deprecated This doesn't work since update's slugs are not unique
      return models.Update.findOne({ where: { slug: args.updateSlug.toLowerCase() } });
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
