import { expect } from 'chai';
import { createSandbox } from 'sinon';

import ActivityTypes, { ActivityClasses } from '../../../server/constants/activities';
import { CollectiveType } from '../../../server/constants/collectives';
import * as redisLib from '../../../server/lib/redis';
import { getCollectiveFeed } from '../../../server/lib/timeline';
import { Activity, Collective, Op, User } from '../../../server/models';
import { fakeActiveHost, fakeCollective, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/lib/timeline', () => {
  const sandbox = createSandbox();

  before(resetTestDB);

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

  it('includes fiscal host note activities in fiscal host feeds', async () => {
    const collective = Collective.build({
      slug: 'timeline-host',
      type: CollectiveType.COLLECTIVE,
      hasHosting: true,
    });

    let finishRebuilding: () => void;
    const rebuilt = new Promise<void>(resolve => (finishRebuilding = resolve));
    const redis = {
      exists: sandbox.stub().resolves(0),
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
    const findAll = sandbox.stub(Activity, 'findAll').resolves([]);

    const result = await getCollectiveFeed({
      collective,
      dateTo: null,
      limit: 20,
      classes: [ActivityClasses.COLLECTIVE],
    });
    await rebuilt;

    expect(result).to.be.null;
    const where = findAll.firstCall.args[0].where;
    const branches = where[Op.or];
    const noteBranch = branches.find(branch => branch.type?.[Op.in]?.includes(ActivityTypes.FISCAL_HOST_NOTE_SET));
    expect(noteBranch).to.exist;
    expect(noteBranch.type[Op.in]).to.eql([ActivityTypes.FISCAL_HOST_NOTE_SET, ActivityTypes.FISCAL_HOST_NOTE_REMOVED]);
    expect(noteBranch.HostCollectiveId).to.equal(collective.id);
    expect(noteBranch.CollectiveId).to.be.undefined;
    expect(noteBranch.FromCollectiveId).to.be.undefined;
    expect(noteBranch[Op.or]).to.be.undefined;
  });

  it('omits fiscal host note activities when the COLLECTIVE class is not requested', async () => {
    const collective = Collective.build({
      slug: 'timeline-host-expenses',
      type: CollectiveType.COLLECTIVE,
      hasHosting: true,
    });

    let finishRebuilding: () => void;
    const rebuilt = new Promise<void>(resolve => (finishRebuilding = resolve));
    const redis = {
      exists: sandbox.stub().resolves(0),
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
    const findAll = sandbox.stub(Activity, 'findAll').resolves([]);

    await getCollectiveFeed({
      collective,
      dateTo: null,
      limit: 20,
      classes: [ActivityClasses.EXPENSES],
    });
    await rebuilt;

    const where = findAll.firstCall.args[0].where;
    const branches = where[Op.or];
    expect(branches.find(branch => branch.type?.[Op.in]?.includes(ActivityTypes.FISCAL_HOST_NOTE_SET))).to.be.undefined;
  });

  it('does not leak notes about the host from another host into its feed', async () => {
    const host = await fakeActiveHost();
    const otherHost = await fakeActiveHost();
    const admin = await fakeUser();
    const flaggedAccount = await fakeCollective({ HostCollectiveId: host.id });

    await Activity.create({
      type: ActivityTypes.FISCAL_HOST_NOTE_SET,
      CollectiveId: host.id,
      HostCollectiveId: host.id,
      FromCollectiveId: flaggedAccount.id,
      UserId: admin.id,
      data: { notify: false },
    });
    // Another host flagged this host: that note must not show up in this host's own feed.
    await Activity.create({
      type: ActivityTypes.FISCAL_HOST_NOTE_SET,
      CollectiveId: otherHost.id,
      HostCollectiveId: otherHost.id,
      FromCollectiveId: host.id,
      UserId: admin.id,
      data: { notify: false },
    });

    sandbox.stub(redisLib, 'createRedisClient').resolves(null);

    const feed = await getCollectiveFeed({
      collective: host,
      dateTo: null,
      limit: 20,
      classes: [ActivityClasses.COLLECTIVE],
    });

    expect(feed).to.have.length(1);
    expect(feed[0].CollectiveId).to.equal(host.id);
    expect(feed[0].FromCollectiveId).to.equal(flaggedAccount.id);
  });
});
