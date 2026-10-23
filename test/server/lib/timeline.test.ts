import { expect } from 'chai';
import { createSandbox } from 'sinon';

import { ActivityClasses } from '../../../server/constants/activities';
import { CollectiveType } from '../../../server/constants/collectives';
import * as redisLib from '../../../server/lib/redis';
import { getCollectiveFeed } from '../../../server/lib/timeline';
import { Activity, Collective, User } from '../../../server/models';

describe('server/lib/timeline', () => {
  const sandbox = createSandbox();

  afterEach(() => sandbox.restore());

  it('rebuilds feeds instead of loading activities cached before follower removal', async () => {
    const collective = Collective.build({ slug: 'timeline-cache', type: CollectiveType.USER });
    const user = User.build();
    sandbox.stub(collective, 'getUser').resolves(user);
    sandbox.stub(user, 'getMemberships').resolves([]);
    sandbox.stub(Activity, 'findAll').resolves([]);

    const legacyKey = `timeline-${collective.slug}-${ActivityClasses.ACTIVITIES_UPDATES}`;
    let finishRebuilding: () => void;
    const rebuilt = new Promise<void>(resolve => (finishRebuilding = resolve));
    const redis = {
      exists: sandbox.stub().callsFake(async key => (key === legacyKey ? 1 : 0)),
      get: sandbox.stub().resolves(null),
      set: sandbox.stub().resolves('OK'),
      del: sandbox.stub().resolves(0),
      zAdd: sandbox.stub().resolves(1),
      zRange: sandbox.stub(),
      expire: sandbox.stub().callsFake(async () => {
        finishRebuilding();
        return 1;
      }),
    };
    sandbox.stub(redisLib, 'createRedisClient').resolves(redis);

    const result = await getCollectiveFeed({
      collective,
      dateTo: null,
      limit: 20,
      classes: [ActivityClasses.ACTIVITIES_UPDATES],
    });
    await rebuilt;

    expect(result).to.be.null;
    expect(redis.exists).to.not.have.been.calledWith(legacyKey);
    expect(redis.zRange).to.not.have.been.called;
    expect(redis.zAdd).to.have.been.calledOnce;
    expect(redis.expire).to.have.been.calledOnce;
  });
});
