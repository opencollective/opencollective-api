import './index';

// eslint-disable-next-line n/no-unpublished-import
import { stub } from 'sinon';

import * as github from './lib/github';
import * as pdf from './lib/pdf';

// GitHub
stub(github, 'checkGithubAdmin');
github.checkGithubAdmin.withArgs('testuseradmingithub/adblockpluschrome', 'foofoo').resolves();
github.checkGithubAdmin.withArgs('demo/dummy', 'foofoo').throws();
github.checkGithubAdmin.resolves();

stub(github, 'checkGithubStars');
github.checkGithubStars.withArgs('testuseradmingithub/adblockpluschrome', 'foofoo').resolves();
github.checkGithubStars.withArgs('demo/dummy', 'foofoo').throws();
github.checkGithubStars.resolves();

// PDF service
stub(pdf, 'getTransactionPdf');
pdf.getTransactionPdf.resolves();
