import { GraphQLString } from 'graphql';

import models from '../../../models';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
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
    },
  },
  async resolve(_, args) {
    if (args.id) {
      return models.Update.findByPk(idDecode(args.id, IDENTIFIER_TYPES.UPDATE));
    } else if (args.updateSlug) {
      return models.Update.findBySlug(args.updateSlug);
    }
  },
};

export default UpdateQuery;
