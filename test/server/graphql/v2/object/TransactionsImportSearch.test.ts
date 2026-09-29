import { expect } from 'chai';
import gql from 'fake-tag';

import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import {
  fakeActiveHost,
  fakeExpense,
  fakeOrder,
  fakeTransactionsImport,
  fakeTransactionsImportRow,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const TRANSACTIONS_IMPORT_ROWS_QUERY = gql`
  query TransactionsImportRows($importId: NonEmptyString!, $searchTerm: String) {
    transactionsImport(id: $importId) {
      rows(searchTerm: $searchTerm) {
        totalCount
        nodes {
          publicId
        }
      }
    }
  }
`;

const OFF_PLATFORM_TRANSACTIONS_QUERY = gql`
  query OffPlatformTransactions($hostSlug: String!, $searchTerm: String) {
    host(slug: $hostSlug) {
      offPlatformTransactions(searchTerm: $searchTerm) {
        totalCount
        nodes {
          publicId
        }
      }
    }
  }
`;

describe('server/graphql/v2/object/TransactionsImport search', () => {
  before(resetTestDB);

  let host;
  let hostAdmin;
  let transactionsImport;
  let expense;
  let order;
  let rows;

  beforeEach(async () => {
    hostAdmin = await fakeUser();
    host = await fakeActiveHost({ admin: hostAdmin });
    transactionsImport = await fakeTransactionsImport({ CollectiveId: host.id, type: 'PLAID' });
    expense = await fakeExpense({ CollectiveId: host.id });
    order = await fakeOrder({ CollectiveId: host.id });
    rows = [
      await fakeTransactionsImportRow({
        TransactionsImportId: transactionsImport.id,
        ExpenseId: expense.id,
        description: 'Expense row description',
        sourceId: 'expense-source-reference',
      }),
      await fakeTransactionsImportRow({
        TransactionsImportId: transactionsImport.id,
        OrderId: order.id,
        description: 'Order row description',
        sourceId: 'order-source-reference',
      }),
      await fakeTransactionsImportRow({
        TransactionsImportId: transactionsImport.id,
        description: 'Unlinked row description',
        sourceId: 'unlinked-source-reference',
      }),
    ];
  });

  const getResults = async (surface: 'import' | 'host', searchTerm: string) => {
    if (surface === 'import') {
      const result = await graphqlQueryV2(
        TRANSACTIONS_IMPORT_ROWS_QUERY,
        { importId: idEncode(transactionsImport.id, IDENTIFIER_TYPES.TRANSACTIONS_IMPORT), searchTerm },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      return result.data.transactionsImport.rows.nodes.map(row => row.publicId);
    } else {
      const result = await graphqlQueryV2(
        OFF_PLATFORM_TRANSACTIONS_QUERY,
        { hostSlug: host.slug, searchTerm },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      return result.data.host.offPlatformTransactions.nodes.map(row => row.publicId);
    }
  };

  for (const surface of ['import', 'host'] as const) {
    it(`searches linked expenses by public and numeric ID on the ${surface} query`, async () => {
      expect(await getResults(surface, expense.publicId)).to.deep.equal([rows[0].publicId]);

      const matchingRows = rows
        .filter(row => row.ExpenseId === expense.id || row.OrderId === expense.id)
        .map(row => row.publicId);
      expect((await getResults(surface, String(expense.id))).sort()).to.deep.equal(matchingRows.sort());
    });

    it(`searches linked orders by public and numeric ID on the ${surface} query`, async () => {
      expect(await getResults(surface, order.publicId)).to.deep.equal([rows[1].publicId]);

      const matchingRows = rows
        .filter(row => row.ExpenseId === order.id || row.OrderId === order.id)
        .map(row => row.publicId);
      expect((await getResults(surface, String(order.id))).sort()).to.deep.equal(matchingRows.sort());
    });

    it(`preserves description and source ID search on the ${surface} query`, async () => {
      expect(await getResults(surface, 'Expense row description')).to.deep.equal([rows[0].publicId]);
      expect(await getResults(surface, 'order-source-reference')).to.deep.equal([rows[1].publicId]);
    });
  }
});
