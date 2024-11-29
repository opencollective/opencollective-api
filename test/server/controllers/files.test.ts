import { expect } from 'chai';
import config from 'config';
import httpMocks from 'node-mocks-http';
import sinon from 'sinon';

import { expenseStatus } from '../../../server/constants';
import * as FilesController from '../../../server/controllers/files';
import { loaders } from '../../../server/graphql/loaders';
import * as awsS3 from '../../../server/lib/awsS3';
import { Collective, Expense, UploadedFile, User } from '../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeExpense,
  fakeExpenseAttachedFile,
  fakeExpenseItem,
  fakePayoutMethod,
  fakeUploadedFile,
  fakeUploadedFileURL,
  fakeUser,
} from '../../test-helpers/fake-data';

function base64UrlEncode(v: string): string {
  return Buffer.from(v).toString('base64url');
}

async function makeRequest(
  base64UrlEncodedUrl: string,
  remoteUser?: User,
  options?: { thumbnail?: boolean },
): Promise<httpMocks.MockResponse<any>> {
  const request = httpMocks.createRequest({
    method: 'GET',
    url: `/api/files/${base64UrlEncodedUrl}`,
    params: {
      base64UrlEncodedUrl,
    },
    query: options?.thumbnail
      ? {
          thumbnail: true,
        }
      : undefined,
  });

  request.remoteUser = remoteUser;
  request.loaders = loaders({ remoteUser });
  const response = httpMocks.createResponse();

  await FilesController.getFile(request, response);

  return response;
}

describe('server/controllers/files', () => {
  let submitter: User;
  let collective: Collective;
  let collectiveAdmin: User;
  let host: Collective;
  let hostAdmin: User;
  let otherUser: User;
  let expenseItemUploadedFile: UploadedFile;
  let expenseAttachedUploadedFile: UploadedFile;
  let uploadedFile: UploadedFile;
  let expense: Expense;

  let sandbox;

  before(async () => {
    sandbox = sinon.createSandbox();

    submitter = await fakeUser();
    otherUser = await fakeUser();
    collectiveAdmin = await fakeUser();
    hostAdmin = await fakeUser();
    host = await fakeActiveHost({
      admin: hostAdmin,
    });
    collective = await fakeCollective({
      HostCollectiveId: host.id,
      admin: collectiveAdmin,
    });

    await collectiveAdmin.populateRoles();
    await hostAdmin.populateRoles();

    uploadedFile = await fakeUploadedFile({
      kind: 'EXPENSE_ITEM',
      CreatedByUserId: otherUser.id,
      fileType: 'application/pdf',
    });

    expenseItemUploadedFile = await fakeUploadedFile({
      kind: 'EXPENSE_ITEM',
      CreatedByUserId: submitter.id,
      fileType: 'application/pdf',
    });

    expenseAttachedUploadedFile = await fakeUploadedFile({
      kind: 'EXPENSE_ATTACHED_FILE',
      CreatedByUserId: submitter.id,
      fileType: 'application/pdf',
    });

    const payoutMethod = await fakePayoutMethod({
      CollectiveId: submitter.collective.id,
    });

    expense = await fakeExpense({
      status: expenseStatus.PENDING,
      amount: 10000,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      currency: 'USD',
      PayoutMethodId: payoutMethod.id,
      type: 'RECEIPT',
      description: 'Reimbursement',
      CreatedByUserId: submitter.id,
    });

    await fakeExpenseItem({
      amount: 10000,
      CreatedByUserId: submitter.id,
      ExpenseId: expense.id,
      description: 'Item',
      url: expenseItemUploadedFile.url,
    });

    await fakeExpenseAttachedFile({
      CreatedByUserId: submitter.id,
      ExpenseId: expense.id,
      url: expenseAttachedUploadedFile.url,
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('authenticated access to files', () => {
    it('should return 401 if not logged in', async () => {
      const s3Url = uploadedFile.getDataValue('url');
      const base64UrlEncodedUrl = base64UrlEncode(s3Url);
      const response = await makeRequest(base64UrlEncodedUrl);

      expect(response._getStatusCode()).to.eql(401);
    });

    it('should return 400 if malformed request', async () => {
      const response = await makeRequest('some-string', otherUser);
      expect(response._getStatusCode()).to.eql(400);
    });

    it('should return 403 if uploaded file does not exist', async () => {
      const s3Url = fakeUploadedFileURL('EXPENSE_ITEM');
      const base64UrlEncodedUrl = base64UrlEncode(s3Url);

      const response = await makeRequest(base64UrlEncodedUrl, otherUser);

      expect(response._getStatusCode()).to.eql(403);
    });

    it('should redirect to recently submitted uploaded file if belongs to user', async () => {
      const actualUrl = uploadedFile.getDataValue('url');
      sandbox.stub(awsS3, 'getSignedGetURL').resolves(`${actualUrl}?signed`);
      const base64UrlEncodedUrl = base64UrlEncode(actualUrl);

      const response = await makeRequest(base64UrlEncodedUrl, otherUser);

      expect(response._getStatusCode()).to.eql(307);
      expect(response._getRedirectUrl()).to.eql(`${actualUrl}?signed`);
    });

    it('should redirect to resource if user has access to expense item', async () => {
      const actualUrl = expenseItemUploadedFile.getDataValue('url');
      sandbox.stub(awsS3, 'getSignedGetURL').resolves(`${actualUrl}?signed`);

      const base64UrlEncodedUrl = base64UrlEncode(actualUrl);

      const otherUserResponse = await makeRequest(base64UrlEncodedUrl, otherUser);
      expect(otherUserResponse._getStatusCode()).to.eql(403);

      const submitterResponse = await makeRequest(base64UrlEncodedUrl, submitter);
      expect(submitterResponse._getStatusCode()).to.eql(307);
      expect(submitterResponse._getRedirectUrl()).to.eql(`${actualUrl}?signed`);

      const hostAdminResponse = await makeRequest(base64UrlEncodedUrl, hostAdmin);
      expect(hostAdminResponse._getStatusCode()).to.eql(307);
      expect(hostAdminResponse._getRedirectUrl()).to.eql(`${actualUrl}?signed`);

      const collectiveAdminResponse = await makeRequest(base64UrlEncodedUrl, collectiveAdmin);
      expect(collectiveAdminResponse._getStatusCode()).to.eql(307);
      expect(collectiveAdminResponse._getRedirectUrl()).to.eql(`${actualUrl}?signed`);
    });

    it('should redirect to resource if user has access to expense attached file', async () => {
      const actualUrl = expenseAttachedUploadedFile.getDataValue('url');
      sandbox.stub(awsS3, 'getSignedGetURL').resolves(`${actualUrl}?signed`);

      const base64UrlEncodedUrl = base64UrlEncode(actualUrl);

      const otherUserResponse = await makeRequest(base64UrlEncodedUrl, otherUser);
      expect(otherUserResponse._getStatusCode()).to.eql(403);

      const submitterResponse = await makeRequest(base64UrlEncodedUrl, submitter);
      expect(submitterResponse._getStatusCode()).to.eql(307);
      expect(submitterResponse._getRedirectUrl()).to.eql(`${actualUrl}?signed`);

      const hostAdminResponse = await makeRequest(base64UrlEncodedUrl, hostAdmin);
      expect(hostAdminResponse._getStatusCode()).to.eql(307);
      expect(hostAdminResponse._getRedirectUrl()).to.eql(`${actualUrl}?signed`);

      const collectiveAdminResponse = await makeRequest(base64UrlEncodedUrl, collectiveAdmin);
      expect(collectiveAdminResponse._getStatusCode()).to.eql(307);
      expect(collectiveAdminResponse._getRedirectUrl()).to.eql(`${actualUrl}?signed`);
    });

    it('should redirect to resource if user has access to expense item thumbnail', async () => {
      const actualUrl = expenseItemUploadedFile.getDataValue('url');
      const thumbnailUrl = `${config.host.website}/static/images/mime-pdf.png`;

      const base64UrlEncodedUrl = base64UrlEncode(actualUrl);

      const otherUserResponse = await makeRequest(base64UrlEncodedUrl, otherUser, {
        thumbnail: true,
      });
      expect(otherUserResponse._getStatusCode()).to.eql(403);

      const submitterResponse = await makeRequest(base64UrlEncodedUrl, submitter, {
        thumbnail: true,
      });
      expect(submitterResponse._getStatusCode()).to.eql(307);
      expect(submitterResponse._getRedirectUrl()).to.eql(thumbnailUrl);

      const hostAdminResponse = await makeRequest(base64UrlEncodedUrl, hostAdmin, {
        thumbnail: true,
      });
      expect(hostAdminResponse._getStatusCode()).to.eql(307);
      expect(hostAdminResponse._getRedirectUrl()).to.eql(thumbnailUrl);

      const collectiveAdminResponse = await makeRequest(base64UrlEncodedUrl, collectiveAdmin, {
        thumbnail: true,
      });
      expect(collectiveAdminResponse._getStatusCode()).to.eql(307);
      expect(collectiveAdminResponse._getRedirectUrl()).to.eql(thumbnailUrl);
    });

    it('should redirect to resource if user has access to expense attached file thumbnail', async () => {
      const actualUrl = expenseAttachedUploadedFile.getDataValue('url');
      const thumbnailUrl = `${config.host.website}/static/images/mime-pdf.png`;

      const base64UrlEncodedUrl = base64UrlEncode(actualUrl);

      const otherUserResponse = await makeRequest(base64UrlEncodedUrl, otherUser, {
        thumbnail: true,
      });
      expect(otherUserResponse._getStatusCode()).to.eql(403);

      const submitterResponse = await makeRequest(base64UrlEncodedUrl, submitter, {
        thumbnail: true,
      });
      expect(submitterResponse._getStatusCode()).to.eql(307);
      expect(submitterResponse._getRedirectUrl()).to.eql(thumbnailUrl);

      const hostAdminResponse = await makeRequest(base64UrlEncodedUrl, hostAdmin, {
        thumbnail: true,
      });
      expect(hostAdminResponse._getStatusCode()).to.eql(307);
      expect(hostAdminResponse._getRedirectUrl()).to.eql(thumbnailUrl);

      const collectiveAdminResponse = await makeRequest(base64UrlEncodedUrl, collectiveAdmin, {
        thumbnail: true,
      });
      expect(collectiveAdminResponse._getStatusCode()).to.eql(307);
      expect(collectiveAdminResponse._getRedirectUrl()).to.eql(thumbnailUrl);
    });
  });
});
