import { expect } from 'chai';

import { BookedTransaction, getDescriptionForTransaction } from '../../../../server/lib/gocardless/sync';

const createGoCardlessTransaction = (overrides: Partial<BookedTransaction> = {}): BookedTransaction =>
  ({
    internalTransactionId: 'tx-1',
    transactionAmount: { amount: '0', currency: 'EUR' },
    ...overrides,
  }) as BookedTransaction;

describe('server/lib/gocardless/sync', () => {
  describe('getDescriptionForTransaction', () => {
    describe('Co-operative Bank override (COOPERATIVE_CPBKGB22)', () => {
      it('formats when BankRef differs from AddInfo', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationUnstructured: 'Faster Payment',
          remittanceInformationUnstructuredArray: ['AddInfo: 000000', 'CustRef: John Doe', 'BankRef: Something'],
        });
        expect(getDescriptionForTransaction(transaction, 'COOPERATIVE_CPBKGB22')).to.equal(
          'Faster Payment: John Doe - Something (000000)',
        );
      });

      it('formats when BankRef equals AddInfo (deduped)', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationUnstructured: 'Faster Payment',
          remittanceInformationUnstructuredArray: ['AddInfo: Ref123', 'CustRef: John Doe', 'BankRef: Ref123'],
        });
        expect(getDescriptionForTransaction(transaction, 'COOPERATIVE_CPBKGB22')).to.equal(
          'Faster Payment: John Doe - Ref123',
        );
      });

      it('omits missing CustRef, BankRef and AddInfo', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationUnstructured: 'Faster Payment',
          remittanceInformationUnstructuredArray: [],
        });
        expect(getDescriptionForTransaction(transaction, 'COOPERATIVE_CPBKGB22')).to.equal('Faster Payment');
      });

      it('handles partial unstructured array (CustRef and AddInfo without BankRef)', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationUnstructured: 'Faster Payment',
          remittanceInformationUnstructuredArray: ['CustRef: Jane', 'AddInfo: 123'],
        });

        expect(getDescriptionForTransaction(transaction, 'COOPERATIVE_CPBKGB22')).to.equal(
          'Faster Payment: Jane - 123',
        );
      });

      it('handles base and CustRef only', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationUnstructured: 'Faster Payment',
          remittanceInformationUnstructuredArray: ['CustRef: Jane'],
        });
        expect(getDescriptionForTransaction(transaction, 'COOPERATIVE_CPBKGB22')).to.equal('Faster Payment: Jane');
      });

      it('handles missing remittanceInformationUnstructured', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationUnstructured: undefined,
          remittanceInformationUnstructuredArray: ['CustRef: Jane', 'BankRef: 123'],
        });
        expect(getDescriptionForTransaction(transaction, 'COOPERATIVE_CPBKGB22')).to.equal('Jane - 123');
      });
    });

    describe('standard GoCardless fields', () => {
      it('uses remittanceInformationStructured when available', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationStructured: 'Structured reference',
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Structured reference');
      });

      it('uses remittanceInformationUnstructured when structured is not available', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationUnstructured: 'Unstructured reference',
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Unstructured reference');
      });

      it('prefers structured over unstructured', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationStructured: 'Structured',
          remittanceInformationUnstructured: 'Unstructured',
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Structured');
      });

      it('uses remittanceInformationStructuredArray when neither single field is available', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationStructuredArray: ['Ref 1', 'Ref 2'],
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Ref 1, Ref 2');
      });

      it('uses remittanceInformationUnstructuredArray as last resort before fallback', () => {
        const transaction = createGoCardlessTransaction({
          remittanceInformationUnstructuredArray: ['Info 1', 'Info 2'],
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Info 1, Info 2');
      });
    });

    describe('fallback description', () => {
      it('generates credit description with creditor name', () => {
        const transaction = createGoCardlessTransaction({
          transactionAmount: { amount: '100.50', currency: 'EUR' },
          creditorName: 'Acme Corp',
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Credit to Acme Corp');
      });

      it('generates debit description with debtor name', () => {
        const transaction = createGoCardlessTransaction({
          transactionAmount: { amount: '-50.25', currency: 'EUR' },
          debtorName: 'John Doe',
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Debit from John Doe');
      });

      it('generates credit description without creditor name', () => {
        const transaction = createGoCardlessTransaction({
          transactionAmount: { amount: '100', currency: 'EUR' },
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Credit');
      });

      it('generates debit description without debtor name', () => {
        const transaction = createGoCardlessTransaction({
          transactionAmount: { amount: '-50', currency: 'EUR' },
        });
        expect(getDescriptionForTransaction(transaction, undefined)).to.equal('Debit');
      });
    });
  });
});
