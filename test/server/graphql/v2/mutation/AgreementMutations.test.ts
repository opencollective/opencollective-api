import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers.js';
import Agreement from '../../../../../server/models/Agreement.js';
import { fakeCollective, fakeHost, fakeUser } from '../../../../test-helpers/fake-data.js';
import { graphqlQueryV2 } from '../../../../utils.js';

const AddAgreementMutation = gqlV2/* GraphQL */ `
  mutation AddAgreementMutation(
    $host: AccountReferenceInput!
    $account: AccountReferenceInput!
    $title: NonEmptyString!
    $expiresAt: DateTime
    $notes: String
    $attachment: Upload
  ) {
    addAgreement(
      host: $host
      account: $account
      title: $title
      expiresAt: $expiresAt
      notes: $notes
      attachment: $attachment
    ) {
      id
      title
      expiresAt
      notes
      attachment {
        id
        url
      }
      account {
        id
        type
      }
      host {
        id
      }
    }
  }
`;

const EditAgreementMutation = gqlV2/* GraphQL */ `
  mutation EditAgreementMutation(
    $agreement: AgreementReferenceInput!
    $title: NonEmptyString
    $expiresAt: DateTime
    $notes: String
    $attachment: Upload
  ) {
    editAgreement(agreement: $agreement, title: $title, expiresAt: $expiresAt, notes: $notes, attachment: $attachment) {
      id
      title
      expiresAt
      notes
      attachment {
        id
        url
      }
      account {
        id
      }
      host {
        id
      }
    }
  }
`;

const DeleteAgreementMutation = gqlV2/* GraphQL */ `
  mutation DeleteAgreementMutation($agreement: AgreementReferenceInput!) {
    deleteAgreement(agreement: $agreement) {
      id
    }
  }
`;

describe('server/graphql/v2/mutation/AgreementMutations', () => {
  describe('addAgreementMutation', () => {
    it('validates request user is authenticated', async () => {
      const result = await graphqlQueryV2(AddAgreementMutation, { host: {}, account: {}, title: 'Test agreement' });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage hosted accounts.');
    });

    it('validates request user is admin of host', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const user = await fakeUser();
      const result = await graphqlQueryV2(
        AddAgreementMutation,
        {
          host: { legacyId: host.id },
          account: { legacyId: collective.id },
          title: 'Test agreement',
        },
        user,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Only host admins can create agreements');
    });

    it('validates account exists', async () => {
      const adminUser = await fakeUser();
      const host = await fakeHost({ admin: adminUser });
      const result = await graphqlQueryV2(
        AddAgreementMutation,
        {
          host: { legacyId: host.id },
          account: { legacyId: -1 },
          title: 'Test agreement',
        },
        adminUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Account Not Found');
    });

    it('adds an agreement to a collective', async () => {
      const adminUser = await fakeUser();
      const host = await fakeHost({ admin: adminUser });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const expiresAt = new Date();
      const result = await graphqlQueryV2(
        AddAgreementMutation,
        {
          host: { legacyId: host.id },
          account: { legacyId: collective.id },
          title: '  Test agreement   ',
          notes: '  Test notes   ',
          expiresAt,
        },
        adminUser,
      );
      result.errors && console.log(result.errors);
      expect(result.data.addAgreement.id).to.exist;
      expect(result.data.addAgreement.title).to.eq('Test agreement');
      expect(result.data.addAgreement.notes).to.eq('Test notes');
      expect(result.data.addAgreement.account.id).to.eq(idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT));
      expect(result.data.addAgreement.account.type).to.eq('COLLECTIVE');
      expect(result.data.addAgreement.host.id).to.eq(idEncode(host.id, IDENTIFIER_TYPES.ACCOUNT));
      expect(result.data.addAgreement.expiresAt.toString()).to.eq(expiresAt.toString());
    });

    it('validates that host is the current host', async () => {
      const adminUser = await fakeUser();
      const host = await fakeHost({ admin: adminUser });
      const collective = await fakeCollective();
      const expiresAt = new Date();
      const result = await graphqlQueryV2(
        AddAgreementMutation,
        {
          host: { legacyId: host.id },
          account: { legacyId: collective.id },
          title: '  Test agreement   ',
          expiresAt,
        },
        adminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('is not currently hosted by Test Host');
    });
  });

  describe('editAgreementMutation', () => {
    it('validates request user is authenticated', async () => {
      const result = await graphqlQueryV2(EditAgreementMutation, { agreement: {}, title: 'Test agreement' });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage hosted accounts.');
    });

    it('validates request user is admin of host', async () => {
      const host = await fakeHost();
      const user = await fakeUser();
      const agreement = await Agreement.create({
        title: 'agreement',
        CollectiveId: user.CollectiveId,
        HostCollectiveId: host.id,
      });
      const result = await graphqlQueryV2(
        EditAgreementMutation,
        {
          agreement: { legacyId: agreement.id },
          title: 'new test agreement title',
        },
        user,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Only host admins can edit agreements');
    });

    it('validates agreement exists', async () => {
      const user = await fakeUser();
      const result = await graphqlQueryV2(
        EditAgreementMutation,
        {
          agreement: { legacyId: -1 },
          title: 'new test agreement title',
        },
        user,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Agreement Not Found');
    });

    it('edits an agreement', async () => {
      const adminUser = await fakeUser();
      const host = await fakeHost({ admin: adminUser });
      const collective = await fakeCollective();

      const agreement = await Agreement.create({
        title: 'agreement',
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
      });

      const expiresAt = new Date();
      const result = await graphqlQueryV2(
        EditAgreementMutation,
        {
          agreement: { legacyId: agreement.id },
          title: 'new agreement title',
          notes: 'new agreement notes',
          expiresAt,
        },
        adminUser,
      );
      result.errors && console.log(result.errors);
      expect(result.data.editAgreement.id).to.exist;
      expect(result.data.editAgreement.title).to.eq('new agreement title');
      expect(result.data.editAgreement.notes).to.eq('new agreement notes');
      expect(result.data.editAgreement.expiresAt.toString()).to.eq(expiresAt.toString());
    });
  });

  describe('deleteAgreement', () => {
    it('validates request user is authenticated', async () => {
      const result = await graphqlQueryV2(DeleteAgreementMutation, { agreement: {}, title: 'Test agreement' });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage hosted accounts.');
    });

    it('validates request user is admin of host', async () => {
      const host = await fakeHost();
      const user = await fakeUser();
      const agreement = await Agreement.create({
        title: 'agreement',
        CollectiveId: user.CollectiveId,
        HostCollectiveId: host.id,
      });
      const result = await graphqlQueryV2(
        DeleteAgreementMutation,
        {
          agreement: { legacyId: agreement.id },
        },
        user,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Only host admins can delete agreements');
    });

    it('validates agreement exists', async () => {
      const user = await fakeUser();
      const result = await graphqlQueryV2(
        DeleteAgreementMutation,
        {
          agreement: { legacyId: -1 },
        },
        user,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Agreement Not Found');
    });
  });
});
