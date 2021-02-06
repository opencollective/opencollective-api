import './index';

// eslint-disable-next-line node/no-unpublished-import
import sinon from 'sinon';

import * as github from './lib/github';
import * as pdf from './lib/pdf';

// GitHub
sinon.stub(github, 'checkGithubAdmin');
github.checkGithubAdmin.withArgs('testuseradmingithub/adblockpluschrome', 'foofoo').resolves();
github.checkGithubAdmin.withArgs('demo/dummy', 'foofoo').throws();
github.checkGithubAdmin.resolves();

sinon.stub(github, 'checkGithubStars');
github.checkGithubStars.withArgs('testuseradmingithub/adblockpluschrome', 'foofoo').resolves();
github.checkGithubStars.withArgs('demo/dummy', 'foofoo').throws();
github.checkGithubStars.resolves();

// PDF service
sinon.stub(pdf, 'getTransactionPdf');
pdf.getTransactionPdf.resolves();
