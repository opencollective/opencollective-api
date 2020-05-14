import sinon from 'sinon';

import * as github from '../../server/lib/github';

// Stubs for 20-github-e2e-create-collective
sinon.stub(github, 'checkGithubAdmin').withArgs('testuseradmingithub', 'faketoken').resolves();
sinon.stub(github, 'checkGithubStars').withArgs('testuseradmingithub', 'faketoken').resolves();
