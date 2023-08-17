import { expect } from 'chai';
import config from 'config';
import { get } from 'lodash';
import { assert, createSandbox, spy } from 'sinon';

import helloworksController from '../../../server/controllers/helloworks';
import * as awsS3Lib from '../../../server/lib/awsS3';
import models from '../../../server/models';
import { randEmail, randUrl } from '../../stores';
import {
  fakeCollective,
  fakeExpense,
  fakeHost,
  fakeLegalDocument,
  fakeOrganization,
  fakeUser,
} from '../../test-helpers/fake-data';

const HELLO_WORKS_WORKFLOW_ID = get(config, 'helloworks.workflowId');

const mockCallbackPayload = ({ accountType, accountId, userId, year }) => {
  const email = randEmail();

  return {
    /* eslint-disable camelcase */
    audit_trail_hash: '38d5aac4a7c55932eff7c857db2b72cde0d29f373f2d4ccee99d2c83xxxxxxxx',
    data: {
      Form_jmV4rR: {
        field_5zvlrH: '12-10-1991',
        field_7G0PTT: 'Test',
        field_8JIBUU: 'No',
        field_HEJfi8: 'Benjamin Piouffle',
        field_Jj5lq3: 'No',
        field_LEHARZ: email,
        field_MdbUXZ: '',
        field_TDttcV: '00000000',
        field_VjJblP: 'France',
        field_W7cOxA: 'an individual person',
        field_XKL6pp: 'Yes',
        field_kIEVyL: '10-10-2020',
        field_nhEGv2: '666 Super street',
      },
    },
    document_hashes: {
      Form_jmV4rR: '14d1d07954f62e4139a3829d4838ccfbfdceaeead7857089c80a7axxxxxxxxxx',
    },
    id: 'W5coo8QIEn2qoJkG',
    metadata: {
      accountId: accountId,
      accountType,
      adminEmails: email,
      email: email,
      userId,
      year,
    },
    mode: 'test',
    status: 'completed',
    type: 'workflow_stopped',
    workflow_id: HELLO_WORKS_WORKFLOW_ID,
    /* eslint-enable camelcase */
  };
};

const getMockedRes = () => ({
  sendStatus: spy(),
});

describe('server/controllers/helloworks', () => {
  let collective, host, s3Stub, expectedDocLocation;
  const sandbox = createSandbox();

  before(async () => {
    host = await fakeHost();
    collective = await fakeCollective({ HostCollectiveId: host.id });
    const requiredDoc = { HostCollectiveId: host.id, documentType: 'US_TAX_FORM' };
    await models.RequiredLegalDocument.create(requiredDoc);
    expectedDocLocation = randUrl();
    s3Stub = sandbox.stub(awsS3Lib, 'uploadToS3').resolves({ url: expectedDocLocation });
  });

  after(() => {
    sandbox.restore();
  });

  beforeEach(() => {
    sandbox.resetHistory();
  });

  it('works with individuals', async () => {
    const user = await fakeUser();
    const year = 2023;
    await fakeExpense({
      status: 'APPROVED',
      FromCollectiveId: user.collective.id,
      amount: 8000,
      currency: 'USD',
      CollectiveId: collective.id,
    });
    const document = await fakeLegalDocument({
      status: 'REQUESTED',
      CollectiveId: user.collective.id,
      year,
    });

    const req = {
      body: mockCallbackPayload({ accountType: collective.type, accountId: user.collective.id, userId: user.id, year }),
    };
    const res = getMockedRes();

    await helloworksController.callback(req, res);
    assert.calledWith(res.sendStatus, 200);
    await document.reload();

    expect(s3Stub.args[0][0].Key).to.eq(`US_TAX_FORM/${year}/${user.collective.name}.pdf`);
    expect(document.requestStatus).to.eq('RECEIVED');
    expect(document.documentLink).to.eq(expectedDocLocation);
  });

  it('works with organizations', async () => {
    const organization = await fakeOrganization();
    const user = await fakeUser();
    await organization.addUserWithRole(user, 'ADMIN');
    const year = 2023;
    await fakeExpense({
      status: 'APPROVED',
      FromCollectiveId: organization.id,
      amount: 8000,
      currency: 'USD',
      CollectiveId: collective.id,
    });
    const document = await fakeLegalDocument({
      status: 'REQUESTED',
      CollectiveId: organization.id,
      year,
    });

    const req = {
      body: mockCallbackPayload({ accountType: organization.type, accountId: organization.id, userId: user.id, year }),
    };
    const res = getMockedRes();

    await helloworksController.callback(req, res);
    assert.calledWith(res.sendStatus, 200);
    await document.reload();

    expect(s3Stub.args[0][0].Key).to.eq(`US_TAX_FORM/${year}/${organization.name}.pdf`);
    expect(document.requestStatus).to.eq('RECEIVED');
    expect(document.documentLink).to.eq(expectedDocLocation);
  });

  it('generates pre-2023 tax forms with a different filename', async () => {
    const organization = await fakeOrganization();
    const user = await fakeUser();
    await organization.addUserWithRole(user, 'ADMIN');
    const year = 2022;
    await fakeExpense({
      status: 'APPROVED',
      FromCollectiveId: organization.id,
      amount: 8000,
      currency: 'USD',
      CollectiveId: collective.id,
    });
    const document = await fakeLegalDocument({ status: 'REQUESTED', CollectiveId: organization.id, year });

    const req = {
      body: mockCallbackPayload({ accountType: organization.type, accountId: organization.id, userId: user.id, year }),
    };
    const res = getMockedRes();

    await helloworksController.callback(req, res);
    assert.calledWith(res.sendStatus, 200);
    await document.reload();

    expect(s3Stub.args[0][0].Key).to.eq(`US_TAX_FORM_${year}_${organization.name}.pdf`);
    expect(document.requestStatus).to.eq('RECEIVED');
    expect(document.documentLink).to.eq(expectedDocLocation);
  });
});
