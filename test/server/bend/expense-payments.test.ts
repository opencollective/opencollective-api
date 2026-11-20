import { expect } from 'chai';

import {
  BEND_EXPENSE_PAYMENT_NAMES,
  decideMarkExpenseAsPaid,
  decidePayExpense,
  ExpensePaymentFacts,
  HostPaymentFacts,
  PaymentDenialReason,
  PaymentVerdict,
  screenExpensePayment,
} from '../../../server/bend/expense-payments';
import ExpenseStatuses from '../../../server/constants/expense-status';
import ExpenseTypes from '../../../server/constants/expense-type';
import { getBendConstructorNames } from '../../test-helpers/bend';

/**
 * The laws in `LAWS.bend` are proven on the Bend source, by `npm run bend:check`. These tests cover what the proofs
 * do not: the compilation to JavaScript and the TypeScript boundary.
 */
describe('server/bend/expense-payments', () => {
  const BOOLEANS = [true, false];
  const ALLOW: PaymentVerdict = { allowed: true };
  const deny = (reason: PaymentDenialReason): PaymentVerdict => ({ allowed: false, reason });

  const ALL_EXPENSE_FACTS: ExpensePaymentFacts[] = Object.values(ExpenseTypes).flatMap(type =>
    Object.values(ExpenseStatuses).flatMap(status =>
      BOOLEANS.flatMap(hasExpensesScope =>
        BOOLEANS.flatMap(isManuallyCreatedCharge =>
          BOOLEANS.map(canUseExpenses => ({ hasExpensesScope, type, isManuallyCreatedCharge, status, canUseExpenses })),
        ),
      ),
    ),
  );

  const ALL_HOST_FACTS: HostPaymentFacts[] = BOOLEANS.flatMap(isBlockedForUnpaidBilling =>
    BOOLEANS.flatMap(isAuthenticated =>
      BOOLEANS.map(isHostAdmin => ({ isBlockedForUnpaidBilling, isAuthenticated, isHostAdmin })),
    ),
  );

  // The rules as they were written in `canMarkAsPaid` and `canPayExpense` before they moved to Bend
  const referenceScreen = (expense: ExpensePaymentFacts): PaymentVerdict => {
    if (!expense.hasExpensesScope) {
      return deny('InvalidScope');
    } else if (expense.type === ExpenseTypes.CHARGE && !expense.isManuallyCreatedCharge) {
      return deny('ChargeNotPayable');
    } else if (!['APPROVED', 'ERROR'].includes(expense.status)) {
      return deny('UnsupportedStatus');
    } else if (!expense.canUseExpenses) {
      return deny('UserFeatureDisabled');
    } else {
      return ALLOW;
    }
  };

  const referenceMarkAsPaid = (expense: ExpensePaymentFacts, host: HostPaymentFacts): PaymentVerdict => {
    const screening = referenceScreen(expense);
    if (!screening.allowed) {
      return screening;
    } else if (
      host.isBlockedForUnpaidBilling &&
      ![ExpenseTypes.SETTLEMENT, ExpenseTypes.PLATFORM_BILLING].includes(expense.type as ExpenseTypes)
    ) {
      return deny('HostBlocked');
    } else if (!host.isAuthenticated) {
      return deny('UserRequired');
    } else if (!host.isHostAdmin) {
      return deny('NotHostAdmin');
    } else {
      return ALLOW;
    }
  };

  const referencePay = (expense: ExpensePaymentFacts, host: HostPaymentFacts): PaymentVerdict => {
    const marking = referenceMarkAsPaid(expense, host);
    if (!marking.allowed) {
      return marking;
    } else if (expense.type === ExpenseTypes.CHARGE) {
      return deny('ChargeNotPayable');
    } else {
      return ALLOW;
    }
  };

  describe('names shared with the Bend source', () => {
    it('are the constructors declared in expense-payments.bend', () => {
      for (const [typeName, names] of Object.entries(BEND_EXPENSE_PAYMENT_NAMES)) {
        expect(names, typeName).to.have.members(getBendConstructorNames('expense-payments.bend', typeName));
      }
    });
  });

  describe('compiled kernel', () => {
    it('decides like the previous TypeScript rules, for every combination of facts', () => {
      expect(ALL_EXPENSE_FACTS).to.have.length(8 * 13 * 8);
      let nbAllowedToPay = 0;
      for (const expense of ALL_EXPENSE_FACTS) {
        expect(screenExpensePayment(expense), JSON.stringify(expense)).to.deep.equal(referenceScreen(expense));
        for (const host of ALL_HOST_FACTS) {
          const description = JSON.stringify({ expense, host });
          const verdict = decidePayExpense(expense, host);
          expect(verdict, description).to.deep.equal(referencePay(expense, host));
          expect(decideMarkExpenseAsPaid(expense, host), description).to.deep.equal(referenceMarkAsPaid(expense, host));
          nbAllowedToPay += verdict.allowed ? 1 : 0;
        }
      }

      // 7 payable types (all but CHARGE) x 2 statuses x 2 (manual flag), for an unblocked host. A blocked host
      // can only pay the 2 platform types.
      expect(nbAllowedToPay).to.equal(7 * 2 * 2 + 2 * 2 * 2);
    });

    it('only lets host admins pay', () => {
      for (const expense of ALL_EXPENSE_FACTS) {
        for (const host of ALL_HOST_FACTS) {
          if (decidePayExpense(expense, host).allowed || decideMarkExpenseAsPaid(expense, host).allowed) {
            expect(host.isHostAdmin).to.be.true;
          }
        }
      }
    });
  });

  describe('boundary', () => {
    const expense: ExpensePaymentFacts = {
      hasExpensesScope: true,
      type: ExpenseTypes.INVOICE,
      isManuallyCreatedCharge: false,
      status: ExpenseStatuses.APPROVED,
      canUseExpenses: true,
    };
    const host: HostPaymentFacts = { isBlockedForUnpaidBilling: false, isAuthenticated: true, isHostAdmin: true };

    it('lets a host admin pay an approved invoice', () => {
      expect(decidePayExpense(expense, host)).to.deep.equal(ALLOW);
    });

    it('refuses facts that are not booleans rather than reading them as false', () => {
      // A missing "blocked" flag read as `false` would let a blocked host pay
      expect(() => decidePayExpense(expense, { ...host, isBlockedForUnpaidBilling: undefined })).to.throw(
        '"isBlockedForUnpaidBilling" must be a boolean',
      );
      expect(() => decidePayExpense(expense, { ...host, isHostAdmin: null })).to.throw('must be a boolean');
      expect(() => screenExpensePayment({ ...expense, isManuallyCreatedCharge: undefined })).to.throw(
        '"isManuallyCreatedCharge" must be a boolean',
      );
    });

    it('refuses an unknown type or status rather than reading it as "none of the cases"', () => {
      // An unknown type is not a CHARGE for the compiled code, which would make it payable
      expect(() => decidePayExpense({ ...expense, type: 'CHARGES' as ExpenseTypes }, host)).to.throw(
        'unknown expense type "CHARGES"',
      );
      expect(() => decidePayExpense({ ...expense, type: 'toString' as ExpenseTypes }, host)).to.throw(
        'unknown expense type',
      );
      expect(() => screenExpensePayment({ ...expense, status: undefined })).to.throw('unknown expense status');
    });
  });
});
