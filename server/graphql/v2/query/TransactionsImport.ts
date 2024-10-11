import { GraphQLNonNull, GraphQLString } from 'graphql';

import models from '../../../models';
import { checkRemoteUserCanUseTransactions } from '../../common/scope-check';
import { Unauthorized } from '../../errors';
import { idDecode } from '../identifiers';
import { GraphQLTransactionsImport } from '../object/TransactionsImport';

const TransactionsImportQuery = {
  type: GraphQLTransactionsImport,
  description: 'Fetch a transactions import',
  args: {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The public id identifying the import (ie: rvelja97-pkzqbgq7-bbzyx6wd-50o8n4rm)',
    },
  },
  async resolve(_, args, req) {
    checkRemoteUserCanUseTransactions(req);
    const transactionsImport = await models.TransactionsImport.findByPk(idDecode(args.id, 'transactions-import'));
    if (!transactionsImport) {
      return null;
    } else if (!req.remoteUser.isAdmin(transactionsImport.CollectiveId)) {
      throw new Unauthorized('You need to be an admin of the account to fetch the import');
    }

    return transactionsImport;
  },
};

export default TransactionsImportQuery;
