import type { Loaders } from '../graphql/loaders';

import { EntityShortIdPrefix } from './permalink/entity-map';
import { parseSearchTerm } from './sql-search';

type LinkedIdSearchCondition = { ExpenseId?: number; OrderId?: number };

/** Build exact ID conditions for linked expenses and orders on imported transaction rows. */
export const getTransactionsImportRowLinkedIdSearchConditions = async (
  searchTerm: string,
  loaders: Loaders,
): Promise<LinkedIdSearchCondition[]> => {
  const parsedSearchTerm = parseSearchTerm(searchTerm);

  if (parsedSearchTerm.type === 'publicId') {
    if (parsedSearchTerm.prefix === EntityShortIdPrefix.Expense) {
      const id = await loaders.Expense.idByPublicId.load(parsedSearchTerm.term);
      return id ? [{ ExpenseId: id }] : [];
    } else if (parsedSearchTerm.prefix === EntityShortIdPrefix.Order) {
      const id = await loaders.Order.idByPublicId.load(parsedSearchTerm.term);
      return id ? [{ OrderId: id }] : [];
    }
  } else if (
    parsedSearchTerm.type === 'number' &&
    !parsedSearchTerm.isFloat &&
    Number.isSafeInteger(parsedSearchTerm.term) &&
    parsedSearchTerm.term > 0
  ) {
    return [{ ExpenseId: parsedSearchTerm.term }, { OrderId: parsedSearchTerm.term }];
  }

  return [];
};
