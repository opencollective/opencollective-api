import { BaseContext, GraphQLRequestContext } from '@apollo/server';
import type { Metric } from '@sentry/node';
import { expect } from 'chai';
import config from 'config';
import sinon from 'sinon';

import logger from '../../../server/lib/logger';
import * as SentryLib from '../../../server/lib/sentry';
import { beforeSendMetric } from '../../../server/lib/sentry/init';
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
      const req = makeRequest(null, 'query { test }');
      req['variables'] = { test: 'test' };

      const captureExceptionSpy = sandbox.spy(SentryLib.Sentry, 'captureException');
      const context = await SentryLib.SentryGraphQLPlugin.requestDidStart({
        request: req,
      } as unknown as GraphQLRequestContext<BaseContext>);
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
      const req = makeRequest(null, 'query { test }');
      req['variables'] = { test: 'test' };

      const context = await SentryLib.SentryGraphQLPlugin.requestDidStart({
        request: req,
      } as unknown as GraphQLRequestContext<BaseContext>);
      const captureExceptionSpy = sandbox.spy(SentryLib.Sentry, 'captureException');
      context['didEncounterErrors']({
        operation: {},
        errors: [{ extensions: { code: 'IGNORED' } }, { path: ['account'], message: 'No collective found' }],
        contextValue: {},
        request: req,
      });
      expect(captureExceptionSpy).to.not.have.been.called;
    });
  });

  describe('reportMessageToSentry', () => {
    it('applies a custom fingerprint to the scope', () => {
      sandbox.stub(config, 'sentry').value({ dsn: 'https://sentry.io/123' });
      const scope = new SentryLib.Sentry.Scope();
      const setFingerprintSpy = sandbox.spy(scope, 'setFingerprint');
      sandbox.stub(SentryLib.Sentry, 'withScope').callsFake(callback => callback(scope));
      const captureMessageStub = sandbox.stub(SentryLib.Sentry, 'captureMessage');

      SentryLib.reportMessageToSentry('Test message', { fingerprint: ['my-custom-group'] });

      expect(setFingerprintSpy).to.have.been.calledOnceWith(['my-custom-group']);
      expect(captureMessageStub).to.have.been.calledOnceWith('Test message');
    });

    it('keeps the default grouping without a fingerprint', () => {
      sandbox.stub(config, 'sentry').value({ dsn: 'https://sentry.io/123' });
      const scope = new SentryLib.Sentry.Scope();
      const setFingerprintSpy = sandbox.spy(scope, 'setFingerprint');
      sandbox.stub(SentryLib.Sentry, 'withScope').callsFake(callback => callback(scope));
      sandbox.stub(SentryLib.Sentry, 'captureMessage');

      SentryLib.reportMessageToSentry('Test message');

      expect(setFingerprintSpy).to.not.have.been.called;
    });
  });

  describe('beforeSendMetric', () => {
    it('keeps metrics whose name matches the grammar', () => {
      const metric: Metric = { name: 'thirdparty.stripe.payment.succeeded', value: 1, type: 'counter' };
      expect(beforeSendMetric(metric)).to.equal(metric);
    });

    it('drops metrics whose name violates the grammar', () => {
      expect(beforeSendMetric({ name: 'totally-invalid', value: 1, type: 'counter' })).to.be.null;
      expect(beforeSendMetric({ name: 'thirdparty.stripe.payment', value: 1, type: 'counter' })).to.be.null;
      expect(beforeSendMetric({ name: 'thirdparty.stripe.payment.succeeded.extra', value: 1, type: 'counter' })).to.be
        .null;
      expect(beforeSendMetric({ name: 'other.stripe.payment.succeeded', value: 1, type: 'counter' })).to.be.null;
    });

    it('logs a warning when dropping a metric', () => {
      const warnSpy = sandbox.spy(logger, 'warn');
      beforeSendMetric({ name: 'invalid-metric-name', value: 1, type: 'counter' });
      expect(warnSpy.called).to.be.true;
      expect(warnSpy.firstCall.args[0]).to.include('invalid-metric-name');
    });
  });
});
