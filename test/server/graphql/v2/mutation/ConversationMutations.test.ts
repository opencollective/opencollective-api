import { expect } from 'chai';
import gql from 'fake-tag';
import { describe, it } from 'mocha';

import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import models from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeConversation,
  fakePrivateOrganization,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const createConversationMutation = gql`
  mutation CreateConversation($account: AccountReferenceInput!, $title: String!, $html: String!) {
    createConversation(account: $account, title: $title, html: $html) {
      id
      title
      account {
        slug
        settings
        members {
          totalCount
        }
      }
    }
  }
`;

const editConversationMutation = gql`
  mutation EditConversation($id: String!, $title: String!) {
    editConversation(id: $id, title: $title) {
      id
      title
      account {
        slug
        settings
        members {
          totalCount
        }
      }
    }
  }
`;

describe('test/server/graphql/v2/mutation/ConversationMutations', () => {
  describe('private account visibility', () => {
    let outsider;
    let privateOrg;
    let privateOrgAdmin;
    let existingConversation;

    before(async function () {
      this.timeout(60_000);
      await resetTestDB();

      outsider = await fakeUser();
      privateOrgAdmin = await fakeUser();
      const privateHost = await fakeActiveHost({ isPrivate: true, admin: privateOrgAdmin.collective });

      privateOrg = await fakePrivateOrganization({
        HostCollectiveId: privateHost.id,
        approvedAt: new Date(),
        admin: privateOrgAdmin.collective,
        settings: { secretInternalKey: 'must-not-leak' } as Record<string, unknown>,
      });

      existingConversation = await fakeConversation({
        CollectiveId: privateOrg.id,
        FromCollectiveId: outsider.CollectiveId,
        CreatedByUserId: outsider.id,
        title: 'Existing conversation',
      });
    });

    it('forbids createConversation on a private account for non-members', async () => {
      const result = await graphqlQueryV2(
        createConversationMutation,
        {
          account: { slug: privateOrg.slug },
          title: 'Probe',
          html: '<p>probe</p>',
        },
        outsider,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions?.code).to.eq('Forbidden');
    });

    it('forbids editConversation for conversation authors who cannot see the private account', async () => {
      const result = await graphqlQueryV2(
        editConversationMutation,
        {
          id: idEncode(existingConversation.id, IDENTIFIER_TYPES.CONVERSATION),
          title: 'Edited title',
        },
        outsider,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions?.code).to.eq('Forbidden');
    });

    it('allows editConversation for private account admins', async () => {
      const result = await graphqlQueryV2(
        editConversationMutation,
        {
          id: idEncode(existingConversation.id, IDENTIFIER_TYPES.CONVERSATION),
          title: 'Admin edit',
        },
        privateOrgAdmin,
      );

      expect(result.errors).to.be.undefined;
      expect(result.data.editConversation.title).to.eq('Admin edit');
      expect(result.data.editConversation.account.slug).to.eq(privateOrg.slug);
    });

    it('blocks nested account reads after privatization for non-members', async () => {
      const publicHost = await fakeActiveHost();
      const owner = await fakeUser();
      const target = await fakeCollective({
        HostCollectiveId: publicHost.id,
        approvedAt: new Date(),
        admin: owner.collective,
        settings: { privatizedSecret: 'must-not-leak' } as Record<string, unknown>,
      });

      const createResult = await graphqlQueryV2(
        createConversationMutation,
        {
          account: { slug: target.slug },
          title: 'Created while public',
          html: '<p>while public</p>',
        },
        outsider,
      );
      expect(createResult.errors).to.be.undefined;

      await models.Collective.update({ isPrivate: true }, { where: { id: target.id } });

      const editResult = await graphqlQueryV2(
        editConversationMutation,
        {
          id: createResult.data.createConversation.id,
          title: 'Edited after privatization',
        },
        outsider,
      );

      expect(editResult.errors).to.exist;
      expect(editResult.errors[0].extensions?.code).to.eq('Forbidden');
    });
  });
});
