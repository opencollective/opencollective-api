import * as Sentry from '@sentry/node';
import { expect } from 'chai';
import sinon from 'sinon';

import * as SentryLib from '../../../server/lib/sentry';
import { makeRequest } from '../../utils';

describe('server/lib/sentry', () => {
  let sandbox;

  before(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('SentryGraphQLPlugin', () => {
    it('should create SPANs for each resolver', () => {
      const transaction = Sentry.startTransaction({ name: 'test' });
      const startChildSpy = sandbox.spy(transaction, 'startChild');
      sandbox.stub(Sentry, 'getCurrentHub').returns({
        getScope: () => ({
          getTransaction: () => transaction,
        }),
      });

      const req = makeRequest();
      req.operationName = 'test';
      const context = SentryLib.SentryGraphQLPlugin.requestDidStart({
        request: req,
        forceSampling: true,
      }).executionDidStart();
      context.willResolveField({ info: { parentType: { name: 'Account' }, fieldName: 'name' } })?.();
      context.willResolveField({ info: { parentType: { name: 'Expense' }, fieldName: 'description' } })?.();
      expect(startChildSpy).to.have.been.calledTwice;
      expect(startChildSpy.firstCall.args[0]).to.deep.equal({
        op: 'resolver',
        description: 'Account.name',
      });
      expect(startChildSpy.secondCall.args[0]).to.deep.equal({
        op: 'resolver',
        description: 'Expense.description',
      });
    });

    it('should create a new transaction if not available', () => {
      const req = makeRequest();
      req.operationName = 'test';
      const startTransactionSpy = sandbox.spy(Sentry, 'startTransaction');
      SentryLib.SentryGraphQLPlugin.requestDidStart({ request: req, forceSampling: true }).executionDidStart();
      expect(startTransactionSpy).to.have.been.calledOnce;
    });

    it('should report errors', () => {
      const req = makeRequest();
      req.query = 'query { test }';
      req.variables = { test: 'test' };

      const context = SentryLib.SentryGraphQLPlugin.requestDidStart({ request: req, forceSampling: true });
      const captureExceptionSpy = sandbox.spy(Sentry, 'captureException');
      context.didEncounterErrors({
        operation: {},
        errors: [{ message: 'Test error 1' }, { message: 'Test error 2' }],
        contextValue: {},
        request: req,
      });
      expect(captureExceptionSpy).to.have.been.calledTwice;
      expect(captureExceptionSpy.firstCall.args[0]).to.deep.equal({ message: 'Test error 1' });
      expect(captureExceptionSpy.secondCall.args[0]).to.deep.equal({ message: 'Test error 2' });
    });

    it('should not report errors that are ignored', () => {
      const req = makeRequest();
      req.query = 'query { test }';
      req.variables = { test: 'test' };

      const context = SentryLib.SentryGraphQLPlugin.requestDidStart({ request: req, forceSampling: true });
      const captureExceptionSpy = sandbox.spy(Sentry, 'captureException');
      context.didEncounterErrors({
        operation: {},
        errors: [{ extensions: { code: 'IGNORED' } }, { path: ['account'], message: 'No collective found' }],
        contextValue: {},
        request: req,
      });
      expect(captureExceptionSpy).to.not.have.been.called;
    });
  });
});
