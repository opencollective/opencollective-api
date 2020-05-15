import './index';

import sinon from 'sinon';

import * as github from './lib/github';

// Stubs for 20-github-e2e-create-collective
sinon.stub(github, 'checkGithubAdmin').withArgs('testuseradmingithub/adblockpluschrome', 'foofoo').resolves();
sinon.stub(github, 'checkGithubStars').withArgs('testuseradmingithub/adblockpluschrome', 'foofoo').resolves();
