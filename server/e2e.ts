import './index';

import { stub } from 'sinon';

import * as github from './lib/github';
import * as pdf from './lib/pdf';

// GitHub
const checkGithubAdmin = stub(github, 'checkGithubAdmin');
checkGithubAdmin.withArgs('testuseradmingithub/adblockpluschrome', 'foofoo').resolves();
checkGithubAdmin.withArgs('demo/dummy', 'foofoo').throws();
checkGithubAdmin.resolves();

const checkGithubStars = stub(github, 'checkGithubStars');
checkGithubStars.withArgs('testuseradmingithub/adblockpluschrome', 'foofoo').resolves();
checkGithubStars.withArgs('demo/dummy', 'foofoo').throws();
checkGithubStars.resolves();

// PDF service
const getTransactionPdf = stub(pdf, 'getTransactionPdf');
getTransactionPdf.resolves();
