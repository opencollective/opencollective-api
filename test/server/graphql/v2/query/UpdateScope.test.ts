import { expect } from 'chai';
import gql from 'fake-tag';

import ActivityTypes from '../../../../../server/constants/activities';
import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import {
  fakeActivity,
  fakeCollective,
  fakePersonalToken,
  fakeUpdate,
  fakeUser,
  fakeUserToken,
  randStr,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, personalTokenGraphqlQueryV2 } from '../../../../utils';

const updateByIdQuery = gql`
  query UpdateById($id: String!) {
    update(id: $id) {
      id
      html
      summary
      userCanSeeUpdate
      isPrivate
      publishedAt
      audienceStats {
        total
      }
      comments {
        totalCount
      }
    }
  }
`;

const updateBySlugQuery = gql`
  query UpdateBySlug($accountSlug: String!, $slug: String!) {
    update(account: { slug: $accountSlug }, slug: $slug) {
      id
      html
      summary
      userCanSeeUpdate
      isPrivate
      publishedAt
      audienceStats {
        total
      }
      comments {
        totalCount
      }
    }
  }
`;

const draftUpdatesQuery = gql`
  query DraftUpdates($slug: String!) {
    account(slug: $slug) {
      updates(isDraft: true) {
        totalCount
        nodes {
          id
          html
          summary
          publishedAt
        }
      }
    }
  }
`;

const updatesQuery = gql`
  query Updates($slug: String!) {
    account(slug: $slug) {
      updates {
        totalCount
        nodes {
          html
          summary
          publishedAt
          isPrivate
          userCanSeeUpdate
        }
      }
    }
  }
`;

const activitiesQuery = gql`
  query UpdateActivities($slug: String!) {
    activities(account: [{ slug: $slug }], type: [COLLECTIVE_UPDATE_CREATED]) {
      totalCount
      nodes {
        type
        data
        update {
          html
          summary
          userCanSeeUpdate
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

describe('server/graphql/v2/query/Update updates scope', () => {
  let admin, stranger, collective, draft, privateUpdate, publicUpdate;
  let draftMarker, privateMarker, publicMarker;

  const idFor = update => idEncode(update.id, IDENTIFIER_TYPES.UPDATE);
  const slugVars = update => ({ accountSlug: collective.slug, slug: update.slug });

  before(async () => {
    draftMarker = `draft-secret-${randStr()}`;
    privateMarker = `private-secret-${randStr()}`;
    publicMarker = `public-update-${randStr()}`;
    admin = await fakeUser();
    stranger = await fakeUser();
    collective = await fakeCollective({ admin });
    draft = await fakeUpdate({
      CollectiveId: collective.id,
      publishedAt: null,
      isPrivate: false,
      html: `<p>${draftMarker}</p>`,
    });
    privateUpdate = await fakeUpdate({
      CollectiveId: collective.id,
      publishedAt: new Date(),
      isPrivate: true,
      html: `<p>${privateMarker}</p>`,
    });
    publicUpdate = await fakeUpdate({
      CollectiveId: collective.id,
      publishedAt: new Date(),
      isPrivate: false,
      html: `<p>${publicMarker}</p>`,
    });

    await fakeActivity(
      {
        type: ActivityTypes.COLLECTIVE_UPDATE_CREATED,
        CollectiveId: collective.id,
        UserId: admin.id,
        FromCollectiveId: admin.CollectiveId,
        data: { update: { id: draft.id, html: draft.html, isPrivate: false, title: draft.title } },
      },
      { hooks: false },
    );
    await fakeActivity(
      {
        type: ActivityTypes.COLLECTIVE_UPDATE_CREATED,
        CollectiveId: collective.id,
        UserId: admin.id,
        FromCollectiveId: admin.CollectiveId,
        data: { update: { id: publicUpdate.id, html: publicUpdate.html, isPrivate: false, title: publicUpdate.title } },
      },
      { hooks: false },
    );
  });

  const expectHiddenUpdate = (result, marker) => {
    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;
    expect(result.data.update).to.be.null;
    expect(JSON.stringify(result.data)).to.not.include(marker);
  };

  const expectRedactedUpdate = (result, marker) => {
    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;
    expect(result.data.update).to.not.be.null;
    expect(result.data.update.userCanSeeUpdate).to.equal(false);
    expect(result.data.update.html).to.be.null;
    expect(result.data.update.summary).to.be.null;
    expect(result.data.update.comments).to.be.null;
    expect(result.data.update.audienceStats).to.be.null;
    expect(JSON.stringify(result.data)).to.not.include(marker);
  };

  const expectVisibleDraft = result => {
    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;
    expect(result.data.update.html).to.equal(draft.html);
    expect(result.data.update.summary).to.equal(draft.summary);
    expect(result.data.update.userCanSeeUpdate).to.equal(true);
    expect(result.data.update.audienceStats).to.not.be.null;
    expect(result.data.update.comments.totalCount).to.equal(0);
    expect(result.data.update.html).to.include(draftMarker);
  };

  describe('session admin can read drafts without an OAuth scope', () => {
    it('reads a draft by id and by slug', async () => {
      const byId = await graphqlQueryV2(updateByIdQuery, { id: idFor(draft) }, admin);
      expectVisibleDraft(byId);

      const bySlug = await graphqlQueryV2(updateBySlugQuery, slugVars(draft), admin);
      expectVisibleDraft(bySlug);
    });

    it('lists draft content from account.updates', async () => {
      const result = await graphqlQueryV2(draftUpdatesQuery, { slug: collective.slug }, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.account.updates.totalCount).to.equal(1);
      expect(result.data.account.updates.nodes[0].html).to.equal(draft.html);
      expect(result.data.account.updates.nodes[0].publishedAt).to.be.null;
    });

    it('reads a published private update', async () => {
      const result = await graphqlQueryV2(updateByIdQuery, { id: idFor(privateUpdate) }, admin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.update.html).to.equal(privateUpdate.html);
      expect(result.data.update.userCanSeeUpdate).to.equal(true);
    });
  });

  describe('anonymous and unrelated users stay redacted', () => {
    it('redacts draft protected fields for anonymous callers', async () => {
      const byId = await graphqlQueryV2(updateByIdQuery, { id: idFor(draft) });
      expectRedactedUpdate(byId, draftMarker);

      const bySlug = await graphqlQueryV2(updateBySlugQuery, slugVars(draft));
      expectRedactedUpdate(bySlug, draftMarker);
    });

    it('redacts draft protected fields for an unrelated account', async () => {
      const byId = await graphqlQueryV2(updateByIdQuery, { id: idFor(draft) }, stranger);
      expectRedactedUpdate(byId, draftMarker);

      const bySlug = await graphqlQueryV2(updateBySlugQuery, slugVars(draft), stranger);
      expectRedactedUpdate(bySlug, draftMarker);
    });

    it('redacts published private updates and still returns published public updates', async () => {
      const privateResult = await graphqlQueryV2(updateBySlugQuery, slugVars(privateUpdate));
      expectRedactedUpdate(privateResult, privateMarker);

      const publicResult = await graphqlQueryV2(updateBySlugQuery, slugVars(publicUpdate));
      expect(publicResult.errors).to.not.exist;
      expect(publicResult.data.update.html).to.equal(publicUpdate.html);
      expect(publicResult.data.update.userCanSeeUpdate).to.equal(true);
    });

    it('returns an empty draft collection and omits draft content from the published collection', async () => {
      const drafts = await graphqlQueryV2(draftUpdatesQuery, { slug: collective.slug }, stranger);
      expect(drafts.errors).to.not.exist;
      expect(drafts.data.account.updates.totalCount).to.equal(0);
      expect(drafts.data.account.updates.nodes).to.deep.equal([]);

      const updates = await graphqlQueryV2(updatesQuery, { slug: collective.slug });
      expect(updates.errors).to.not.exist;
      const nodes = updates.data.account.updates.nodes;
      expect(nodes.every(node => node.publishedAt !== null)).to.equal(true);
      expect(nodes.some(node => node.html === publicUpdate.html)).to.equal(true);
      expect(nodes.some(node => node.isPrivate && node.html === null && node.userCanSeeUpdate === false)).to.equal(
        true,
      );
      expect(JSON.stringify(updates.data)).to.not.include(draftMarker);
      expect(JSON.stringify(updates.data)).to.not.include(privateMarker);
    });
  });

  for (const client of tokenClients) {
    describe(client.label, () => {
      it('scope [] hides draft and private updates but keeps published public updates', async () => {
        const draftById = await client.query(updateByIdQuery, { id: idFor(draft) }, admin, []);
        expectHiddenUpdate(draftById, draftMarker);

        const draftBySlug = await client.query(updateBySlugQuery, slugVars(draft), admin, []);
        expectHiddenUpdate(draftBySlug, draftMarker);

        const privateById = await client.query(updateByIdQuery, { id: idFor(privateUpdate) }, admin, []);
        expectHiddenUpdate(privateById, privateMarker);

        const privateBySlug = await client.query(updateBySlugQuery, slugVars(privateUpdate), admin, []);
        expectHiddenUpdate(privateBySlug, privateMarker);

        const publicById = await client.query(updateByIdQuery, { id: idFor(publicUpdate) }, admin, []);
        expect(publicById.errors).to.not.exist;
        expect(publicById.data.update.html).to.equal(publicUpdate.html);
        expect(publicById.data.update.summary).to.equal(publicUpdate.summary);
        expect(publicById.data.update.userCanSeeUpdate).to.equal(true);
      });

      it('scope [account] returns no drafts and redacts unpublished activity updates', async () => {
        const drafts = await client.query(draftUpdatesQuery, { slug: collective.slug }, admin, [OAuthScopes.account]);
        drafts.errors && console.error(drafts.errors);
        expect(drafts.errors).to.not.exist;
        expect(drafts.data.account.updates.totalCount).to.equal(0);
        expect(drafts.data.account.updates.nodes).to.deep.equal([]);
        expect(JSON.stringify(drafts.data)).to.not.include(draftMarker);

        const updates = await client.query(updatesQuery, { slug: collective.slug }, admin, [OAuthScopes.account]);
        expect(updates.errors).to.not.exist;
        const nodes = updates.data.account.updates.nodes;
        expect(nodes.some(node => node.html === publicUpdate.html)).to.equal(true);
        expect(nodes.some(node => node.isPrivate && node.html === null && node.userCanSeeUpdate === false)).to.equal(
          true,
        );
        expect(nodes.every(node => node.html !== draft.html)).to.equal(true);
        expect(JSON.stringify(updates.data)).to.not.include(draftMarker);
        expect(JSON.stringify(updates.data)).to.not.include(privateMarker);

        const activities = await client.query(activitiesQuery, { slug: collective.slug }, admin, [OAuthScopes.account]);
        activities.errors && console.error(activities.errors);
        expect(activities.errors).to.not.exist;
        expect(activities.data.activities.totalCount).to.be.greaterThan(0);
        const activityNodes = activities.data.activities.nodes;
        expect(activityNodes.some(node => node.update && node.update.html === publicUpdate.html)).to.equal(true);
        expect(activityNodes.some(node => node.update === null)).to.equal(true);
        expect(activityNodes.every(node => !node.update || node.update.html !== draft.html)).to.equal(true);
        expect(JSON.stringify(activities.data)).to.not.include(draftMarker);
      });

      it('scope [updates] lets an admin read draft content directly and from the collection', async () => {
        const byId = await client.query(updateByIdQuery, { id: idFor(draft) }, admin, [OAuthScopes.updates]);
        expectVisibleDraft(byId);

        const bySlug = await client.query(updateBySlugQuery, slugVars(draft), admin, [OAuthScopes.updates]);
        expectVisibleDraft(bySlug);

        const privateResult = await client.query(updateBySlugQuery, slugVars(privateUpdate), admin, [
          OAuthScopes.updates,
        ]);
        expect(privateResult.errors).to.not.exist;
        expect(privateResult.data.update.html).to.equal(privateUpdate.html);
        expect(privateResult.data.update.summary).to.equal(privateUpdate.summary);
        expect(privateResult.data.update.userCanSeeUpdate).to.equal(true);

        const drafts = await client.query(draftUpdatesQuery, { slug: collective.slug }, admin, [OAuthScopes.updates]);
        expect(drafts.errors).to.not.exist;
        expect(drafts.data.account.updates.totalCount).to.equal(1);
        expect(drafts.data.account.updates.nodes[0].html).to.equal(draft.html);
        expect(drafts.data.account.updates.nodes[0].summary).to.equal(draft.summary);

        const updates = await client.query(updatesQuery, { slug: collective.slug }, admin, [OAuthScopes.updates]);
        expect(updates.errors).to.not.exist;
        const nodes = updates.data.account.updates.nodes;
        expect(nodes.some(node => node.html === draft.html && node.userCanSeeUpdate === true)).to.equal(true);
        expect(nodes.some(node => node.html === privateUpdate.html && node.isPrivate === true)).to.equal(true);
        expect(nodes.some(node => node.html === publicUpdate.html)).to.equal(true);
      });

      it('scope [account, updates] returns unpublished update content on activities', async () => {
        const activities = await client.query(activitiesQuery, { slug: collective.slug }, admin, [
          OAuthScopes.account,
          OAuthScopes.updates,
        ]);
        activities.errors && console.error(activities.errors);
        expect(activities.errors).to.not.exist;
        const nodes = activities.data.activities.nodes;
        expect(nodes.some(node => node.update && node.update.html === draft.html)).to.equal(true);
        expect(nodes.some(node => node.update && node.update.html === publicUpdate.html)).to.equal(true);
      });

      it('scope [updates] still redacts drafts for an unrelated account', async () => {
        const byId = await client.query(updateByIdQuery, { id: idFor(draft) }, stranger, [OAuthScopes.updates]);
        expectRedactedUpdate(byId, draftMarker);

        const bySlug = await client.query(updateBySlugQuery, slugVars(draft), stranger, [OAuthScopes.updates]);
        expectRedactedUpdate(bySlug, draftMarker);

        const drafts = await client.query(draftUpdatesQuery, { slug: collective.slug }, stranger, [
          OAuthScopes.updates,
        ]);
        expect(drafts.errors).to.not.exist;
        expect(drafts.data.account.updates.totalCount).to.equal(0);
        expect(JSON.stringify(drafts.data)).to.not.include(draftMarker);
      });
    });
  }
});
