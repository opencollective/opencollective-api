import { expect } from 'chai';
import config from 'config';
import { Request, Response } from 'express';
import sinon from 'sinon';

import logger from '../../server/lib/logger';
import { MiddlewareTimingTracker, withTiming } from '../../server/lib/middleware-timing';
import { makeRequest } from '../utils';

describe('middleware-timing', () => {
  let tracker: MiddlewareTimingTracker;
  let clock: sinon.SinonFakeTimers;
  let mockReq: any;

  beforeEach(() => {
    clock = sinon.useFakeTimers();

    // Stub the config import
    sinon.stub(config.log, 'slowMiddlewareThreshold').value(100);
    sinon.stub(config.log, 'slowMiddleware').value(true);

    mockReq = makeRequest();
    tracker = new MiddlewareTimingTracker(mockReq);
  });

  afterEach(() => {
    clock.restore();
    sinon.restore();
  });

  describe('MiddlewareTimingTracker', () => {
    it('should have default threshold of 100ms', () => {
      expect(tracker['threshold']).to.equal(100);
    });

    it('should track timing', () => {
      const endTiming = tracker.startTiming('testMiddleware');

      // Advance time by 50ms
      clock.tick(50);
      endTiming();

      const timings = tracker.getTimings();
      expect(timings.get('testMiddleware')).to.be.closeTo(50, 1);
    });

    it('should log slow middleware', () => {
      tracker['threshold'] = 10;
      const logSpy = sinon.spy(logger, 'warn');

      const endTiming = tracker.startTiming('slowMiddleware');

      // Advance time by 20ms (above threshold)
      clock.tick(20);
      endTiming();

      expect(logSpy.calledOnce).to.be.true;
      expect(logSpy.firstCall.args[0]).to.include('Slow middleware detected: slowMiddleware');
    });

    it('should include user info in slow middleware logs', () => {
      tracker['threshold'] = 10;
      const mockUser = { id: 123, email: 'test@example.com' };
      const mockReqWithUser = makeRequest(mockUser);
      const logSpy = sinon.spy(logger, 'warn');
      const trackerWithUser = new MiddlewareTimingTracker(mockReqWithUser as unknown as Express.Request);

      const endTiming = trackerWithUser.startTiming('slowMiddleware');
      clock.tick(150);
      endTiming();

      expect(logSpy.calledOnce).to.be.true;
      expect(logSpy.firstCall.args[0]).to.include(`user:${mockUser.id}`);
    });

    it('should get timing for specific middleware', () => {
      const endTiming = tracker.startTiming('testMiddleware');
      clock.tick(50);
      endTiming();

      expect(tracker.getTiming('testMiddleware')).to.be.closeTo(50, 1);
      expect(tracker.getTiming('nonexistent')).to.be.undefined;
    });

    it('should clear timings', () => {
      const endTiming = tracker.startTiming('testMiddleware');
      clock.tick(50);
      endTiming();

      expect(tracker.getTimings().size).to.equal(1);

      tracker.clear();
      expect(tracker.getTimings().size).to.equal(0);
    });
  });

  describe('withTiming', () => {
    it('should wrap middleware with timing', done => {
      const mockRes = {} as Response;

      let middlewareCalled = false;
      const testMiddleware = (req: Request, res: Response, next: (error?: any) => void) => {
        middlewareCalled = true;
        clock.tick(50);
        next();
      };

      const wrappedMiddleware = withTiming('testMiddleware', testMiddleware);

      wrappedMiddleware(mockReq, mockRes, () => {
        expect(middlewareCalled).to.be.true;
        expect(mockReq.middlewareTimingTracker).to.exist;
        expect(mockReq.middlewareTimingTracker!.getTiming('testMiddleware')).to.be.closeTo(50, 1);
        done();
      });
    });

    it('should reuse existing tracker for same request', done => {
      const mockRes = {} as Response;

      // Create first middleware
      const firstMiddleware = (req: Request, res: Response, next: (error?: any) => void) => {
        clock.tick(25);
        next();
      };

      const wrappedFirst = withTiming('firstMiddleware', firstMiddleware);

      // Create second middleware
      const secondMiddleware = (req: Request, res: Response, next: (error?: any) => void) => {
        clock.tick(25);
        next();
      };

      const wrappedSecond = withTiming('secondMiddleware', secondMiddleware);

      // Execute first middleware
      wrappedFirst(mockReq, mockRes, () => {
        // Execute second middleware
        wrappedSecond(mockReq, mockRes, () => {
          expect(mockReq.middlewareTimingTracker).to.exist;
          expect(mockReq.middlewareTimingTracker!.getTiming('firstMiddleware')).to.be.closeTo(25, 1);
          expect(mockReq.middlewareTimingTracker!.getTiming('secondMiddleware')).to.be.closeTo(25, 1);
          expect(mockReq.middlewareTimingTracker!.getTimings().size).to.equal(2);
          done();
        });
      });
    });

    it('should handle middleware errors', done => {
      const mockRes = {} as Response;

      const testError = new Error('Test error');
      const testMiddleware = (req: Request, res: Response, next: (error?: any) => void) => {
        clock.tick(50);
        next(testError);
      };

      const wrappedMiddleware = withTiming('testMiddleware', testMiddleware);

      wrappedMiddleware(mockReq, mockRes, error => {
        expect(error).to.equal(testError);
        expect(mockReq.middlewareTimingTracker).to.exist;
        expect(mockReq.middlewareTimingTracker!.getTiming('testMiddleware')).to.be.closeTo(50, 1);
        done();
      });
    });
  });
});
