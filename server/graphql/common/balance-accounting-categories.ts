import type { AccountingCategory, Collective } from '../../models';
import { BalanceSheetAccountingCategoryKind } from '../../models/AccountingCategory';
import { ValidationFailed } from '../errors';

const BALANCE_SHEET_ACCOUNTING_CATEGORY_KINDS: string[] = Object.values(BalanceSheetAccountingCategoryKind);

/**
 * Throws if the accounting category cannot be used as a balance/clearing account for this host.
 */
export const checkIsValidBalanceAccountingCategory = (
  accountingCategory: AccountingCategory | undefined | null,
  host: Collective,
): void => {
  if (!accountingCategory) {
    return;
  } else if (accountingCategory.CollectiveId !== host.id) {
    throw new ValidationFailed('This accounting category is not allowed for this host');
  } else if (!accountingCategory.kind || !BALANCE_SHEET_ACCOUNTING_CATEGORY_KINDS.includes(accountingCategory.kind)) {
    throw new ValidationFailed('This accounting category is not a balance or clearing account');
  }
};
