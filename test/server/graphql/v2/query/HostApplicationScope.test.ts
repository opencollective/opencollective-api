import { expect } from 'chai';
import gql from 'fake-tag';

import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import models from '../../../../../server/models';
import { CommentType } from '../../../../../server/models/Comment';
import { HostApplicationStatus } from '../../../../../server/models/HostApplication';
import {
  fakeCollective,
  fakeHost,
  fakeHostApplication,
  fakePersonalToken,
  fakeUser,
  fakeUserToken,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, personalTokenGraphqlQueryV2, resetTestDB } from '../../../../utils';

const DIRECT_QUERY = gql`
  query DirectHostApplication($id: String!) {
    hostApplication(hostApplication: { id: $id }) {
      id
      status
      message
      customData
      comments {
        totalCount
        nodes {
          id
          type
          html
        }
      }
    }
  }
`;

const APPLICANT_COLLECTION_QUERY = gql`
  query ApplicantRequests($slug: String!) {
    account(slug: $slug) {
      hostApplicationRequests {
        totalCount
        nodes {
          id
          status
          message
        }
      }
    }
  }
`;

const HOST_COLLECTION_QUERY = gql`
  query HostApplications($slug: String!) {
    host(slug: $slug) {
      hostApplications {
        totalCount
        nodes {
          id
          status
          message
        }
      }
    }
  }
`;

const NESTED_QUERY = gql`
  query NestedHostApplication($slug: String!) {
    account(slug: $slug) {
      ... on AccountWithHost {
        hostApplication {
          id
          message
          customData
        }
      }
    }
  }
`;

const tokenClients = [
  {
    label: 'personal token',
    query: async (source, variables, user, scope: OAuthScopes[]) => {
      const token = await fakePersonalToken({ user, scope });
      return personalTokenGraphqlQueryV2(source, variables, token);
    },
  },
  {
    label: 'OAuth token',
    query: async (source, variables, user, scope: OAuthScopes[]) => {
      const token = await fakeUserToken({ user, scope });
      return oAuthGraphqlQueryV2(source, variables, token);
    },
  },
];

describe('server/graphql/v2/query/HostApplication scope', () => {
  let hostAdmin, collectiveAdmin, stranger, host, collective, application, applicationRef;

  before(async () => {
    await resetTestDB();
    hostAdmin = await fakeUser();
    collectiveAdmin = await fakeUser();
    stranger = await fakeUser();
    host = await fakeHost({ admin: hostAdmin });
    collective = await fakeCollective({
      admin: collectiveAdmin,
      HostCollectiveId: host.id,
      isActive: false,
      approvedAt: null,
    });
    application = await fakeHostApplication({
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      status: HostApplicationStatus.PENDING,
      message: 'secret-application-message',
      customData: {
        secret: 'secret-custom-value',
        repositoryUrl: 'https://github.com/opencollective/test',
        validatedRepositoryInfo: { stars: 1 },
      },
    });
    applicationRef = { id: idEncode(application.id, IDENTIFIER_TYPES.HOST_APPLICATION) };

    await models.Comment.create({
      CollectiveId: collective.id,
      FromCollectiveId: collectiveAdmin.CollectiveId,
      CreatedByUserId: collectiveAdmin.id,
      HostApplicationId: application.id,
      ExpenseId: null,
      html: 'public-comment-body',
      type: CommentType.COMMENT,
    });
    await models.Comment.create({
      CollectiveId: collective.id,
      FromCollectiveId: hostAdmin.CollectiveId,
      CreatedByUserId: hostAdmin.id,
      HostApplicationId: application.id,
      ExpenseId: null,
      html: 'private-note-body',
      type: CommentType.PRIVATE_NOTE,
    });
  });

  describe('session auth (no token)', () => {
    it('lets the applicant admin read the direct application with private fields', async () => {
      const result = await graphqlQueryV2(DIRECT_QUERY, applicationRef, collectiveAdmin);
      expect(result.errors).to.not.exist;
      expect(result.data.hostApplication.message).to.equal('secret-application-message');
      expect(result.data.hostApplication.customData.secret).to.equal('secret-custom-value');
      expect(result.data.hostApplication.comments.totalCount).to.equal(1);
      expect(result.data.hostApplication.comments.nodes.map(n => n.type)).to.deep.equal(['COMMENT']);
    });

    it('lets the host admin read the direct application including the private note', async () => {
      const result = await graphqlQueryV2(DIRECT_QUERY, applicationRef, hostAdmin);
      expect(result.errors).to.not.exist;
      expect(result.data.hostApplication.message).to.equal('secret-application-message');
      expect(result.data.hostApplication.comments.totalCount).to.equal(2);
      expect(result.data.hostApplication.comments.nodes.map(n => n.type).sort()).to.deep.equal([
        'COMMENT',
        'PRIVATE_NOTE',
      ]);
    });

    it('denies anonymous and unrelated users on all three paths', async () => {
      const directAnonymous = await graphqlQueryV2(DIRECT_QUERY, applicationRef);
      expect(directAnonymous.errors).to.exist;
      expect(directAnonymous.data.hostApplication).to.be.null;

      const directStranger = await graphqlQueryV2(DIRECT_QUERY, applicationRef, stranger);
      expect(directStranger.errors).to.exist;
      expect(directStranger.data.hostApplication).to.be.null;

      const applicantDenied = await graphqlQueryV2(APPLICANT_COLLECTION_QUERY, { slug: collective.slug }, stranger);
      expect(applicantDenied.errors).to.exist;

      const hostDenied = await graphqlQueryV2(HOST_COLLECTION_QUERY, { slug: host.slug }, stranger);
      expect(hostDenied.errors).to.exist;
    });
  });

  for (const client of tokenClients) {
    describe(client.label, () => {
      it('denies zero-scope admin tokens on all three paths', async () => {
        const direct = await client.query(DIRECT_QUERY, applicationRef, collectiveAdmin, []);
        expect(direct.errors).to.exist;
        expect(direct.errors[0].extensions.code).to.equal('Forbidden');

        const applicant = await client.query(
          APPLICANT_COLLECTION_QUERY,
          { slug: collective.slug },
          collectiveAdmin,
          [],
        );
        expect(applicant.errors).to.exist;
        expect(applicant.errors[0].extensions.code).to.equal('Forbidden');

        const hostResult = await client.query(HOST_COLLECTION_QUERY, { slug: host.slug }, hostAdmin, []);
        expect(hostResult.errors).to.exist;
        expect(hostResult.errors[0].extensions.code).to.equal('Forbidden');
      });

      it('denies tokens with the wrong scope', async () => {
        const direct = await client.query(DIRECT_QUERY, applicationRef, collectiveAdmin, [OAuthScopes.account]);
        expect(direct.errors).to.exist;
        expect(direct.errors[0].extensions.code).to.equal('Forbidden');

        const hostResult = await client.query(HOST_COLLECTION_QUERY, { slug: host.slug }, hostAdmin, [
          OAuthScopes.host,
        ]);
        expect(hostResult.errors).to.exist;
        expect(hostResult.errors[0].extensions.code).to.equal('Forbidden');
      });

      it('allows applicant and host admins with the applications scope', async () => {
        const asApplicant = await client.query(DIRECT_QUERY, applicationRef, collectiveAdmin, [
          OAuthScopes.applications,
        ]);
        expect(asApplicant.errors).to.not.exist;
        expect(asApplicant.data.hostApplication.message).to.equal('secret-application-message');

        const asHost = await client.query(DIRECT_QUERY, applicationRef, hostAdmin, [OAuthScopes.applications]);
        expect(asHost.errors).to.not.exist;
        expect(asHost.data.hostApplication.message).to.equal('secret-application-message');

        const applicant = await client.query(APPLICANT_COLLECTION_QUERY, { slug: collective.slug }, collectiveAdmin, [
          OAuthScopes.applications,
        ]);
        expect(applicant.errors).to.not.exist;
        expect(applicant.data.account.hostApplicationRequests.totalCount).to.be.greaterThan(0);

        const hostResult = await client.query(HOST_COLLECTION_QUERY, { slug: host.slug }, hostAdmin, [
          OAuthScopes.applications,
        ]);
        expect(hostResult.errors).to.not.exist;
        expect(hostResult.data.host.hostApplications.totalCount).to.be.greaterThan(0);
      });

      it('still denies unrelated accounts with the applications scope', async () => {
        const direct = await client.query(DIRECT_QUERY, applicationRef, stranger, [OAuthScopes.applications]);
        expect(direct.errors).to.exist;

        const applicant = await client.query(APPLICANT_COLLECTION_QUERY, { slug: collective.slug }, stranger, [
          OAuthScopes.applications,
        ]);
        expect(applicant.errors).to.exist;

        const hostResult = await client.query(HOST_COLLECTION_QUERY, { slug: host.slug }, stranger, [
          OAuthScopes.applications,
        ]);
        expect(hostResult.errors).to.exist;
      });

      it('splits PRIVATE_NOTE visibility between applicant and host admins', async () => {
        const asApplicant = await client.query(DIRECT_QUERY, applicationRef, collectiveAdmin, [
          OAuthScopes.applications,
        ]);
        expect(asApplicant.errors).to.not.exist;
        expect(asApplicant.data.hostApplication.comments.totalCount).to.equal(1);
        expect(asApplicant.data.hostApplication.comments.nodes.map(n => n.type)).to.deep.equal(['COMMENT']);

        const asHost = await client.query(DIRECT_QUERY, applicationRef, hostAdmin, [OAuthScopes.applications]);
        expect(asHost.errors).to.not.exist;
        expect(asHost.data.hostApplication.comments.totalCount).to.equal(2);
        expect(asHost.data.hostApplication.comments.nodes.map(n => n.type).sort()).to.deep.equal([
          'COMMENT',
          'PRIVATE_NOTE',
        ]);
      });

      it('enforces the scope on nested message/customData returned via account.hostApplication', async () => {
        const denied = await client.query(NESTED_QUERY, { slug: collective.slug }, collectiveAdmin, []);
        expect(denied.errors).to.exist;
        expect(denied.errors[0].extensions.code).to.equal('Forbidden');

        const allowed = await client.query(NESTED_QUERY, { slug: collective.slug }, collectiveAdmin, [
          OAuthScopes.applications,
        ]);
        expect(allowed.errors).to.not.exist;
        expect(allowed.data.account.hostApplication.message).to.equal('secret-application-message');
        expect(allowed.data.account.hostApplication.customData.secret).to.equal('secret-custom-value');
      });
    });
  }
});
