import sinon from 'sinon';

import { checkGithubAdmin, checkGithubStars } from '../../server/lib/github';

sinon.stub(checkGithubAdmin).withArgs(['testuseradmingithub', 'faketoken']).resolve();
sinon.stub(checkGithubStars).withArgs(['testuseradmingithub', 'faketoken']).resolve();
