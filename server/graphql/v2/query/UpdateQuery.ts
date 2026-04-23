import express from 'express';
import { GraphQLString } from 'graphql';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import { assertCanSeeAccount } from '../../../lib/private-accounts';
import models, { Update } from '../../../models';
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
  async resolve(_, args, req: express.Request): Promise<Update | null> {
    if (args.id) {
      const update = isEntityPublicId(args.id, EntityShortIdPrefix.Update)
        ? await req.loaders.Update.byPublicId.load(args.id)
        : await models.Update.findByPk(idDecode(args.id, IDENTIFIER_TYPES.UPDATE));

      if (update) {
        const account = await req.loaders.Collective.byId.load(update.CollectiveId);
        await assertCanSeeAccount(req, account);
      }

      return update;
    } else if (args.account && args.slug) {
      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      await assertCanSeeAccount(req, account);
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
