import { BaseContext, GraphQLRequestContext } from '@apollo/server';
import { expect } from 'chai';
import config from 'config';
import sinon from 'sinon';

import * as SentryLib from '../../../server/lib/sentry';
import { makeRequest } from '../../utils';

describe('server/lib/sentry', () => {
  let sandbox;

  before(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(config, 'sentry').value({ dsn: 'https://sentry.io/123' });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('SentryGraphQLPlugin', () => {
    it('should report errors', async () => {
      const req = makeRequest();
      req.query = 'query { test }';
      req.variables = { test: 'test' };

      const reportErrorSpy = sandbox.spy(SentryLib, 'reportErrorToSentry');
      const context = await SentryLib.SentryGraphQLPlugin.requestDidStart({
        request: req,
      } as unknown as GraphQLRequestContext<BaseContext>);
      context['didEncounterErrors']({
        operation: {},
        errors: [{ message: 'Test error 1' }, { message: 'Test error 2' }],
        contextValue: {},
        request: req,
      });
      expect(reportErrorSpy).to.have.been.calledTwice;
      expect(reportErrorSpy.firstCall.args[0]).to.deep.equal({ message: 'Test error 1' });
      expect(reportErrorSpy.secondCall.args[0]).to.deep.equal({ message: 'Test error 2' });
    });

    it('should not report errors that are ignored', async () => {
      const req = makeRequest();
      req.query = 'query { test }';
      req.variables = { test: 'test' };

      const context = await SentryLib.SentryGraphQLPlugin.requestDidStart({
        request: req,
      } as unknown as GraphQLRequestContext<BaseContext>);
      const reportErrorSpy = sandbox.spy(SentryLib, 'reportErrorToSentry');
      context['didEncounterErrors']({
        operation: {},
        errors: [{ extensions: { code: 'IGNORED' } }, { path: ['account'], message: 'No collective found' }],
        contextValue: {},
        request: req,
      });
      expect(reportErrorSpy).to.not.have.been.called;
    });
  });
});
