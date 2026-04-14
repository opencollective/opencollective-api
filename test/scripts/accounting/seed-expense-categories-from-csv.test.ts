import { expect } from 'chai';

import { parseExpenseCategoriesCsv } from '../../../scripts/accounting/seed-expense-categories-from-csv';

describe('scripts/accounting/seed-expense-categories-from-csv', () => {
  it('parses CSV with headers and skips empty lines', () => {
    const csvContent = ['Short Group ID,EXP CODE', 'abc,FOO', '', 'xyz,BAR', ''].join('\n');

    const records = parseExpenseCategoriesCsv(csvContent);

    expect(records).to.deep.equal([
      { 'Short Group ID': 'abc', 'EXP CODE': 'FOO' },
      { 'Short Group ID': 'xyz', 'EXP CODE': 'BAR' },
    ]);
  });
});
