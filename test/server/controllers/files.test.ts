import { expect } from 'chai';
import config from 'config';
import httpMocks from 'node-mocks-http';
import sinon from 'sinon';

import { expenseStatus } from '../../../server/constants';
import * as FilesController from '../../../server/controllers/files';
import { loaders } from '../../../server/graphql/loaders';
import { idEncode, IDENTIFIER_TYPES } from '../../../server/graphql/v2/identifiers';
import * as awsS3 from '../../../server/lib/awsS3';
import * as thumbnailsLib from '../../../server/lib/thumbnails';
import { Collective, Expense, UploadedFile, User } from '../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeExpense,
  fakeExpenseAttachedFile,
  fakeExpenseItem,
  fakePayoutMethod,
  fakeUploadedFile,
  fakeUser,
} from '../../test-helpers/fake-data';

async function makeRequest(
  id: number,
  remoteUser?: User,
  options?: { thumbnail?: boolean; expenseId?: string; draftKey?: string },
): Promise<httpMocks.MockResponse<any>> {
  const encodedId = idEncode(id, IDENTIFIER_TYPES.UPLOADED_FILE);
  const request = httpMocks.createRequest({
    method: 'GET',
    url: `/api/files/${encodedId}`,
    params: {
      uploadedFileId: encodedId,
    },
    query: options,
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

  const draftKey = 'draft-key';
  let draftExpense: Expense;

  let draftExpenseItemUploadedFile: UploadedFile;
  let draftExpenseAttachedUploadedFile: UploadedFile;

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
      FromCollectiveId: submitter.collective.id,
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
      url: expenseItemUploadedFile.getDataValue('url'),
    });

    await fakeExpenseAttachedFile({
      CreatedByUserId: submitter.id,
      ExpenseId: expense.id,
      url: expenseAttachedUploadedFile.getDataValue('url'),
    });

    draftExpenseItemUploadedFile = await fakeUploadedFile({
      kind: 'EXPENSE_ITEM',
      CreatedByUserId: submitter.id,
      fileType: 'application/pdf',
    });

    draftExpenseAttachedUploadedFile = await fakeUploadedFile({
      kind: 'EXPENSE_ATTACHED_FILE',
      CreatedByUserId: submitter.id,
      fileType: 'application/pdf',
    });

    draftExpense = await fakeExpense({
      status: expenseStatus.DRAFT,
      amount: 10000,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      FromCollectiveId: submitter.collective.id,
      currency: 'USD',
      PayoutMethodId: payoutMethod.id,
      type: 'RECEIPT',
      description: 'Reimbursement',
      CreatedByUserId: submitter.id,
      data: {
        draftKey,
        items: [
          {
            url: draftExpenseItemUploadedFile.getDataValue('url'),
          },
        ],
        attachedFiles: [
          {
            url: draftExpenseAttachedUploadedFile.getDataValue('url'),
          },
        ],
      },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('authenticated access to files', () => {
    it('should return 403 if not logged in', async () => {
      const response = await makeRequest(uploadedFile.id);

      expect(response._getStatusCode()).to.eql(403);
    });

    it('should return 400 if malformed request', async () => {
      const request = httpMocks.createRequest({
        method: 'GET',
        url: `/api/files/invalid-id`,
        params: {
          uploadedFileId: 'invalid-id',
        },
      });

      const response = httpMocks.createResponse();

      request.remoteUser = otherUser;
      request.loaders = loaders({ remoteUser: otherUser });
      await FilesController.getFile(request, response);

      expect(response._getStatusCode()).to.eql(400);
    });

    it('should return 403 if uploaded file does not exist', async () => {
      const deletedUploadedFile = await fakeUploadedFile();
      await deletedUploadedFile.destroy();
      const response = await makeRequest(deletedUploadedFile.id, otherUser);

      expect(response._getStatusCode()).to.eql(403);
    });

    it('should redirect to recently submitted uploaded file if belongs to user', async () => {
      const actualUrl = uploadedFile.getDataValue('url');
      sandbox.stub(awsS3, 'getSignedGetURL').resolves(`${actualUrl}?signed`);

      const response = await makeRequest(uploadedFile.id, otherUser);

      expect(response._getStatusCode()).to.eql(307);
      expect(response._getRedirectUrl()).to.eql(`${actualUrl}?signed`);
    });

    it('should redirect to resource if user has access to expense item', async () => {
      const actualUrl = expenseItemUploadedFile.getDataValue('url');
      sandbox.stub(awsS3, 'getSignedGetURL').resolves(`${actualUrl}?signed`);

      const otherUserResponse = await makeRequest(expenseItemUploadedFile.id, otherUser);
      expect(otherUserResponse._getStatusCode()).to.eql(403);

      const submitterResponse = await makeRequest(expenseItemUploadedFile.id, submitter);
      expect(submitterResponse._getStatusCode()).to.eql(307);
      expect(submitterResponse._getRedirectUrl()).to.eql(`${actualUrl}?signed`);

      const hostAdminResponse = await makeRequest(expenseItemUploadedFile.id, hostAdmin);
      expect(hostAdminResponse._getStatusCode()).to.eql(307);
      expect(hostAdminResponse._getRedirectUrl()).to.eql(`${actualUrl}?signed`);

      const collectiveAdminResponse = await makeRequest(expenseItemUploadedFile.id, collectiveAdmin);
      expect(collectiveAdminResponse._getStatusCode()).to.eql(307);
      expect(collectiveAdminResponse._getRedirectUrl()).to.eql(`${actualUrl}?signed`);
    });

    it('should redirect to resource if user has access to expense attached file', async () => {
      const actualUrl = expenseAttachedUploadedFile.getDataValue('url');
      sandbox.stub(awsS3, 'getSignedGetURL').resolves(`${actualUrl}?signed`);

      const otherUserResponse = await makeRequest(expenseAttachedUploadedFile.id, otherUser);
      expect(otherUserResponse._getStatusCode()).to.eql(403);

      const submitterResponse = await makeRequest(expenseAttachedUploadedFile.id, submitter);
      expect(submitterResponse._getStatusCode()).to.eql(307);
      expect(submitterResponse._getRedirectUrl()).to.eql(`${actualUrl}?signed`);

      const hostAdminResponse = await makeRequest(expenseAttachedUploadedFile.id, hostAdmin);
      expect(hostAdminResponse._getStatusCode()).to.eql(307);
      expect(hostAdminResponse._getRedirectUrl()).to.eql(`${actualUrl}?signed`);

      const collectiveAdminResponse = await makeRequest(expenseAttachedUploadedFile.id, collectiveAdmin);
      expect(collectiveAdminResponse._getStatusCode()).to.eql(307);
      expect(collectiveAdminResponse._getRedirectUrl()).to.eql(`${actualUrl}?signed`);
    });

    it('should redirect to resource if user has access to expense item thumbnail', async () => {
      const thumbnailUrl = `${config.host.website}/static/images/mime-pdf.png`;
      sandbox.stub(thumbnailsLib, 'generateThumbnailFromBucketUrl').resolves(null);

      const otherUserResponse = await makeRequest(expenseAttachedUploadedFile.id, otherUser, {
        thumbnail: true,
      });
      expect(otherUserResponse._getStatusCode()).to.eql(403);

      const submitterResponse = await makeRequest(expenseAttachedUploadedFile.id, submitter, {
        thumbnail: true,
      });
      expect(submitterResponse._getStatusCode()).to.eql(307);
      expect(submitterResponse._getRedirectUrl()).to.eql(thumbnailUrl);

      const hostAdminResponse = await makeRequest(expenseAttachedUploadedFile.id, hostAdmin, {
        thumbnail: true,
      });
      expect(hostAdminResponse._getStatusCode()).to.eql(307);
      expect(hostAdminResponse._getRedirectUrl()).to.eql(thumbnailUrl);

      const collectiveAdminResponse = await makeRequest(expenseAttachedUploadedFile.id, collectiveAdmin, {
        thumbnail: true,
      });
      expect(collectiveAdminResponse._getStatusCode()).to.eql(307);
      expect(collectiveAdminResponse._getRedirectUrl()).to.eql(thumbnailUrl);
    });

    it('should redirect to resource if user has access to expense attached file thumbnail', async () => {
      const thumbnailUrl = `${config.host.website}/static/images/mime-pdf.png`;
      sandbox.stub(thumbnailsLib, 'generateThumbnailFromBucketUrl').resolves(null);

      const otherUserResponse = await makeRequest(expenseAttachedUploadedFile.id, otherUser, {
        thumbnail: true,
      });
      expect(otherUserResponse._getStatusCode()).to.eql(403);

      const submitterResponse = await makeRequest(expenseAttachedUploadedFile.id, submitter, {
        thumbnail: true,
      });
      expect(submitterResponse._getStatusCode()).to.eql(307);
      expect(submitterResponse._getRedirectUrl()).to.eql(thumbnailUrl);

      const hostAdminResponse = await makeRequest(expenseAttachedUploadedFile.id, hostAdmin, {
        thumbnail: true,
      });
      expect(hostAdminResponse._getStatusCode()).to.eql(307);
      expect(hostAdminResponse._getRedirectUrl()).to.eql(thumbnailUrl);

      const collectiveAdminResponse = await makeRequest(expenseAttachedUploadedFile.id, collectiveAdmin, {
        thumbnail: true,
      });
      expect(collectiveAdminResponse._getStatusCode()).to.eql(307);
      expect(collectiveAdminResponse._getRedirectUrl()).to.eql(thumbnailUrl);
    });

    describe('draft expenses', () => {
      it('should redirect to resource if user has access to draft expense item', async () => {
        const actualUrl = draftExpenseItemUploadedFile.getDataValue('url');
        sandbox.stub(awsS3, 'getSignedGetURL').resolves(`${actualUrl}?signed`);

        const otherUserResponse = await makeRequest(draftExpenseItemUploadedFile.id, otherUser);
        expect(otherUserResponse._getStatusCode()).to.eql(403);

        const otherUserWithDraftKeyResponse = await makeRequest(draftExpenseItemUploadedFile.id, otherUser, {
          expenseId: idEncode(draftExpense.id, IDENTIFIER_TYPES.EXPENSE),
          draftKey,
        });
        expect(otherUserWithDraftKeyResponse._getStatusCode()).to.eql(307);
        expect(otherUserWithDraftKeyResponse._getRedirectUrl()).to.eql(`${actualUrl}?signed`);

        const submitterResponse = await makeRequest(draftExpenseItemUploadedFile.id, submitter);
        expect(submitterResponse._getStatusCode()).to.eql(307);
        expect(submitterResponse._getRedirectUrl()).to.eql(`${actualUrl}?signed`);

        const hostAdminResponse = await makeRequest(draftExpenseItemUploadedFile.id, hostAdmin);
        expect(hostAdminResponse._getStatusCode()).to.eql(403);

        const hostAdminWithExpenseIdResponse = await makeRequest(draftExpenseItemUploadedFile.id, hostAdmin, {
          expenseId: idEncode(draftExpense.id, IDENTIFIER_TYPES.EXPENSE),
        });
        expect(hostAdminWithExpenseIdResponse._getStatusCode()).to.eql(307);
        expect(hostAdminWithExpenseIdResponse._getRedirectUrl()).to.eql(`${actualUrl}?signed`);

        const collectiveAdminResponse = await makeRequest(draftExpenseItemUploadedFile.id, collectiveAdmin);
        expect(collectiveAdminResponse._getStatusCode()).to.eql(403);

        const collectiveAdminWithExpenseIdResponse = await makeRequest(
          draftExpenseItemUploadedFile.id,
          collectiveAdmin,
          {
            expenseId: idEncode(draftExpense.id, IDENTIFIER_TYPES.EXPENSE),
          },
        );
        expect(collectiveAdminWithExpenseIdResponse._getStatusCode()).to.eql(307);
        expect(collectiveAdminWithExpenseIdResponse._getRedirectUrl()).to.eql(`${actualUrl}?signed`);
      });
    });
  });
});
