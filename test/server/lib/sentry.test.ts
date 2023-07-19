import { BaseContext, GraphQLRequestContext } from '@apollo/server';
import * as Sentry from '@sentry/node';
import { expect } from 'chai';
import sinon from 'sinon';

import * as SentryLib from '../../../server/lib/sentry.js';
import { makeRequest } from '../../utils.js';

describe('server/lib/sentry', () => {
  let sandbox;

  before(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('SentryGraphQLPlugin', () => {
    it('should report errors', async () => {
      const req = makeRequest();
      req.query = 'query { test }';
      req.variables = { test: 'test' };

      const context = await SentryLib.SentryGraphQLPlugin.requestDidStart({
        request: req,
      } as unknown as GraphQLRequestContext<BaseContext>);
      const captureExceptionSpy = sandbox.spy(Sentry, 'captureException');
      context['didEncounterErrors']({
        operation: {},
        errors: [{ message: 'Test error 1' }, { message: 'Test error 2' }],
        contextValue: {},
        request: req,
      });
      expect(captureExceptionSpy).to.have.been.calledTwice;
      expect(captureExceptionSpy.firstCall.args[0]).to.deep.equal({ message: 'Test error 1' });
      expect(captureExceptionSpy.secondCall.args[0]).to.deep.equal({ message: 'Test error 2' });
    });

    it('should not report errors that are ignored', async () => {
      const req = makeRequest();
      req.query = 'query { test }';
      req.variables = { test: 'test' };

      const context = await SentryLib.SentryGraphQLPlugin.requestDidStart({
        request: req,
      } as unknown as GraphQLRequestContext<BaseContext>);
      const captureExceptionSpy = sandbox.spy(Sentry, 'captureException');
      context['didEncounterErrors']({
        operation: {},
        errors: [{ extensions: { code: 'IGNORED' } }, { path: ['account'], message: 'No collective found' }],
        contextValue: {},
        request: req,
      });
      expect(captureExceptionSpy).to.not.have.been.called;
    });
  });
});
