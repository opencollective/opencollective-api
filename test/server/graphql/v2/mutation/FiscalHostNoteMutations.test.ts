import { expect } from 'chai';
import gql from 'fake-tag';

import ActivityTypes from '../../../../../server/constants/activities';
import { CollectiveType } from '../../../../../server/constants/collectives';
import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import { sanitizeActivityData } from '../../../../../server/graphql/common/activities';
import models, { sequelize } from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeActivity,
  fakeCollective,
  fakeIncognitoProfile,
  fakeOrder,
  fakeOrganization,
  fakePersonalToken,
  fakeUser,
  fakeVendor,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const SET_NOTE_MUTATION = gql`
  mutation SetFiscalHostNote($input: SetFiscalHostNoteInput!) {
    setFiscalHostNote(input: $input) {
      type
      note
      updatedAt
      updatedBy {
        slug
      }
    }
  }
`;

const REMOVE_NOTE_MUTATION = gql`
  mutation RemoveFiscalHostNote($input: RemoveFiscalHostNoteInput!) {
    removeFiscalHostNote(input: $input)
  }
`;

const INCOGNITO_ORDER_NOTE_QUERY = gql`
  query IncognitoOrderNote($orderId: Int!, $host: AccountReferenceInput!) {
    order(order: { legacyId: $orderId }) {
      fromAccount {
        fiscalHostNote(host: $host) {
          note
        }
      }
    }
  }
`;

const READ_NOTE_QUERY = gql`
  query FiscalHostNote($accountSlug: String!, $host: AccountReferenceInput!) {
    account(slug: $accountSlug) {
      fiscalHostNote(host: $host) {
        type
        note
        updatedAt
        updatedBy {
          slug
        }
      }
    }
  }
`;

const COMMUNITY_ACTIVITIES_QUERY = gql`
  query CommunityActivities($accountSlug: String!, $host: AccountReferenceInput!) {
    account(slug: $accountSlug) {
      communityStats(host: $host) {
        activities(limit: 10) {
          totalCount
          nodes {
            id
            type
            data
          }
        }
      }
    }
  }
`;

const HOSTED_COLLECTIVE_ACTIVITIES_QUERY = gql`
  query HostedCollectiveActivities($id: String!) {
    activities(account: { id: $id }, type: [COLLECTIVE], limit: 10) {
      nodes {
        type
        data
      }
    }
  }
`;

const ACTIVITIES_QUERY = gql`
  query Activities(
    $account: [AccountReferenceInput!]
    $individual: AccountReferenceInput
    $host: AccountReferenceInput
  ) {
    activities(account: $account, individual: $individual, host: $host, limit: 10) {
      totalCount
      nodes {
        id
        type
        data
      }
    }
  }
`;

describe('server/graphql/v2/mutation/FiscalHostNoteMutations', () => {
  let host, hostAdmin, secondHostAdmin, individual, organization, vendor, collective;

  before(resetTestDB);
  before(async () => {
    hostAdmin = await fakeUser();
    host = await fakeActiveHost({ admin: hostAdmin });
    secondHostAdmin = await fakeUser();
    individual = await fakeUser();
    organization = await fakeOrganization();
    vendor = await fakeVendor({ ParentCollectiveId: host.id });
    collective = await fakeCollective({ admin: hostAdmin });

    // The AccountDetails activity tab goes through `communityStats`, which only exists for
    // accounts that have a tracked relationship with the host.
    await fakeActivity({
      type: ActivityTypes.COLLECTIVE_EXPENSE_CREATED,
      CollectiveId: collective.id,
      FromCollectiveId: individual.CollectiveId,
      HostCollectiveId: host.id,
      UserId: individual.id,
      data: {},
    });
    await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityActivitySummary"');
  });

  const setNote = (input, remoteUser = hostAdmin) =>
    graphqlQueryV2(SET_NOTE_MUTATION, { input: { host: { legacyId: host.id }, ...input } }, remoteUser);

  const removeNote = (input, remoteUser = hostAdmin) =>
    graphqlQueryV2(REMOVE_NOTE_MUTATION, { input: { host: { legacyId: host.id }, ...input } }, remoteUser);

  beforeEach(async () => {
    await models.Activity.destroy({
      where: { type: [ActivityTypes.FISCAL_HOST_NOTE_SET, ActivityTypes.FISCAL_HOST_NOTE_REMOVED] },
    });
    await models.FiscalHostNote.destroy({ where: {} });
  });

  describe('setFiscalHostNote', () => {
    it('requires the user to be logged in', async () => {
      const result = await setNote(
        { account: { legacyId: individual.CollectiveId }, type: 'WARNING', note: 'Watch out' },
        null,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage hosted accounts.');
    });

    it('rejects users that are not admins of the host', async () => {
      const result = await setNote(
        {
          account: { legacyId: individual.CollectiveId },
          type: 'WARNING',
          note: 'Watch out',
        },
        await fakeUser(),
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Only host admins can set fiscal host notes');
    });

    it('rejects accounts that are not fiscal hosts', async () => {
      const result = await graphqlQueryV2(
        SET_NOTE_MUTATION,
        {
          input: {
            host: { legacyId: collective.id },
            account: { legacyId: individual.CollectiveId },
            type: 'WARNING',
            note: 'Watch out',
          },
        },
        hostAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Only fiscal hosts can have fiscal host notes');
    });

    it('rejects unsupported account types', async () => {
      const platform = await fakeCollective({ type: CollectiveType.PLATFORM });
      const result = await setNote({
        account: { legacyId: platform.id },
        type: 'WARNING',
        note: 'Watch out',
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'Only individuals, organizations, vendors and collectives can be flagged',
      );
    });

    it('rejects empty notes', async () => {
      const result = await setNote({
        account: { legacyId: individual.CollectiveId },
        type: 'WARNING',
        note: '   ',
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Note cannot be empty');
    });

    it('rejects notes longer than 5000 characters', async () => {
      const result = await setNote({
        account: { legacyId: individual.CollectiveId },
        type: 'WARNING',
        note: 'a'.repeat(5001),
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Note is too long (maximum 5000 characters)');
    });

    it('rejects notes that sanitize to an empty string', async () => {
      const result = await setNote({
        account: { legacyId: individual.CollectiveId },
        type: 'WARNING',
        note: '<script>alert(1)</script>',
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Note cannot be empty');
    });

    it('rejects notes that grow past the limit after sanitization', async () => {
      const result = await setNote({
        account: { legacyId: individual.CollectiveId },
        type: 'WARNING',
        note: `${'a'.repeat(4950)}<a href="https://example.com">x</a>`,
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Note is too long (maximum 5000 characters)');
    });

    it('sanitizes the note while keeping links', async () => {
      const result = await setNote({
        account: { legacyId: individual.CollectiveId },
        type: 'INFO',
        note: '<p>Hello <a href="https://opencollective.com/help">link</a></p><script>alert(1)</script>',
      });
      expect(result.errors).to.not.exist;
      expect(result.data.setFiscalHostNote.note).to.include('<p>Hello');
      expect(result.data.setFiscalHostNote.note).to.include('href="https://opencollective.com/help"');
      expect(result.data.setFiscalHostNote.note).to.not.include('<script>');
      expect(result.data.setFiscalHostNote.note).to.not.include('alert(1)');
    });

    it('rewrites untrusted links through the redirect', async () => {
      const result = await setNote({
        account: { legacyId: individual.CollectiveId },
        type: 'INFO',
        note: '<p>See <a href="https://example.com">this</a></p>',
      });
      expect(result.errors).to.not.exist;
      expect(result.data.setFiscalHostNote.note).to.include('/redirect?url=');
    });

    it('does not require two-factor authentication', async () => {
      const adminWith2FA = await fakeUser({}, {}, { enable2FA: true });
      const twoFactorHost = await fakeActiveHost({ admin: adminWith2FA });

      const setResult = await graphqlQueryV2(
        SET_NOTE_MUTATION,
        {
          input: {
            host: { legacyId: twoFactorHost.id },
            account: { legacyId: individual.CollectiveId },
            type: 'INFO',
            note: 'No 2FA needed',
          },
        },
        adminWith2FA,
      );
      expect(setResult.errors).to.not.exist;
      expect(setResult.data.setFiscalHostNote.note).to.equal('No 2FA needed');

      const removeResult = await graphqlQueryV2(
        REMOVE_NOTE_MUTATION,
        { input: { host: { legacyId: twoFactorHost.id }, account: { legacyId: individual.CollectiveId } } },
        adminWith2FA,
      );
      expect(removeResult.errors).to.not.exist;
      expect(removeResult.data.removeFiscalHostNote).to.equal(true);
    });

    it('supports Individuals, Organizations, Vendors and collective account types', async () => {
      const fund = await fakeCollective({ type: CollectiveType.FUND });
      const project = await fakeCollective({ type: CollectiveType.PROJECT });
      const event = await fakeCollective({ type: CollectiveType.EVENT });
      for (const account of [individual.collective, organization, vendor, collective, fund, project, event]) {
        const result = await setNote({
          account: { legacyId: account.id },
          type: 'WARNING',
          note: `Note for ${account.type}`,
        });
        expect(result.errors).to.not.exist;
        expect(result.data.setFiscalHostNote.note).to.equal(`Note for ${account.type}`);
      }
    });

    it('supports the POSITIVE level', async () => {
      const result = await setNote({
        account: { legacyId: individual.CollectiveId },
        type: 'POSITIVE',
        note: 'Great contributor',
      });
      expect(result.errors).to.not.exist;
      expect(result.data.setFiscalHostNote.type).to.equal('POSITIVE');
      expect(result.data.setFiscalHostNote.note).to.equal('Great contributor');
    });

    it('rejects incognito targets without incognito authorization', async () => {
      const user = await fakeUser();
      const incognitoProfile = await fakeIncognitoProfile(user);

      const result = await setNote({
        account: { legacyId: incognitoProfile.id },
        type: 'WARNING',
        note: 'Watch this contributor',
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'You are not allowed to manage fiscal host notes for this incognito profile',
      );
      expect(
        await models.FiscalHostNote.count({ where: { HostCollectiveId: host.id, CollectiveId: user.CollectiveId } }),
      ).to.equal(0);
    });

    it('stores the note in the FiscalHostNotes table', async () => {
      const result = await setNote({
        account: { legacyId: individual.CollectiveId },
        type: 'WARNING',
        note: 'Watch out',
      });
      expect(result.errors).to.not.exist;
      expect(result.data.setFiscalHostNote.type).to.equal('WARNING');
      expect(result.data.setFiscalHostNote.note).to.equal('Watch out');
      expect(result.data.setFiscalHostNote.updatedAt).to.exist;
      expect(result.data.setFiscalHostNote.updatedBy.slug).to.equal(hostAdmin.collective.slug);

      const stored = await models.FiscalHostNote.findOne({
        where: { HostCollectiveId: host.id, CollectiveId: individual.CollectiveId },
      });
      expect(stored).to.exist;
      expect(stored.type).to.equal('WARNING');
      expect(stored.note).to.equal('Watch out');
      expect(stored.CreatedByUserId).to.equal(hostAdmin.id);
      expect(stored.UpdatedByUserId).to.equal(hostAdmin.id);
    });

    it('overwrites the existing note instead of stacking', async () => {
      await setNote({ account: { legacyId: individual.CollectiveId }, type: 'WARNING', note: 'First note' });
      await setNote({ account: { legacyId: individual.CollectiveId }, type: 'INFO', note: 'Second note' });

      const notes = await models.FiscalHostNote.findAll({
        where: { HostCollectiveId: host.id, CollectiveId: individual.CollectiveId },
      });
      expect(notes).to.have.length(1);
      expect(notes[0].type).to.equal('INFO');
      expect(notes[0].note).to.equal('Second note');
    });

    it('creates a silent activity with a snapshot of the note', async () => {
      await setNote({ account: { legacyId: individual.CollectiveId }, type: 'WARNING', note: 'Watch out' });

      const activity = await models.Activity.findOne({
        where: { type: ActivityTypes.FISCAL_HOST_NOTE_SET },
        order: [['id', 'DESC']],
      });
      expect(activity).to.exist;
      expect(activity.CollectiveId).to.equal(host.id);
      expect(activity.FromCollectiveId).to.equal(individual.CollectiveId);
      expect(activity.HostCollectiveId).to.equal(host.id);
      expect(activity.UserId).to.equal(hostAdmin.id);
      expect(activity.data.notify).to.equal(false);
      expect(activity.data.note).to.equal('Watch out');
      expect(activity.data.noteType).to.equal('WARNING');
    });

    it('creates a new activity with each snapshot when the note is overwritten', async () => {
      await setNote({ account: { legacyId: individual.CollectiveId }, type: 'WARNING', note: 'First note' });
      await setNote({ account: { legacyId: individual.CollectiveId }, type: 'INFO', note: 'Second note' });

      const activities = await models.Activity.findAll({
        where: { type: ActivityTypes.FISCAL_HOST_NOTE_SET },
        order: [['id', 'DESC']],
      });
      expect(activities).to.have.length(2);
      expect(activities[0].data.note).to.equal('Second note');
      expect(activities[1].data.note).to.equal('First note');
    });
  });

  describe('removeFiscalHostNote', () => {
    it('requires host admin permissions', async () => {
      const result = await removeNote({ account: { legacyId: individual.CollectiveId } }, await fakeUser());
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Only host admins can remove fiscal host notes');
      expect(secondHostAdmin).to.exist;
    });

    it("removes only this host's note", async () => {
      const otherHost = await fakeActiveHost({ admin: secondHostAdmin });
      await setNote({ account: { legacyId: individual.CollectiveId }, type: 'WARNING', note: 'Host note' });
      await graphqlQueryV2(
        SET_NOTE_MUTATION,
        {
          input: {
            host: { legacyId: otherHost.id },
            account: { legacyId: individual.CollectiveId },
            type: 'INFO',
            note: 'Other host note',
          },
        },
        secondHostAdmin,
      );

      const result = await removeNote({ account: { legacyId: individual.CollectiveId } });
      expect(result.errors).to.not.exist;
      expect(result.data.removeFiscalHostNote).to.equal(true);

      const remaining = await models.FiscalHostNote.findAll({
        where: { CollectiveId: individual.CollectiveId },
      });
      expect(remaining).to.have.length(1);
      expect(remaining[0].HostCollectiveId).to.equal(otherHost.id);
      expect(remaining[0].note).to.equal('Other host note');
    });

    it('rejects incognito targets without incognito authorization on removal', async () => {
      const user = await fakeUser();
      const incognitoProfile = await fakeIncognitoProfile(user);
      await setNote({ account: { legacyId: user.CollectiveId }, type: 'WARNING', note: 'Watch out' });

      const result = await removeNote({ account: { legacyId: incognitoProfile.id } });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'You are not allowed to manage fiscal host notes for this incognito profile',
      );
      expect(
        await models.FiscalHostNote.count({
          where: { HostCollectiveId: host.id, CollectiveId: user.CollectiveId },
        }),
      ).to.equal(1);
    });

    it('creates a silent removal activity with the last snapshot', async () => {
      await setNote({ account: { legacyId: individual.CollectiveId }, type: 'WARNING', note: 'Watch out' });
      await removeNote({ account: { legacyId: individual.CollectiveId } });

      const activity = await models.Activity.findOne({
        where: { type: ActivityTypes.FISCAL_HOST_NOTE_REMOVED },
        order: [['id', 'DESC']],
      });
      expect(activity).to.exist;
      expect(activity.CollectiveId).to.equal(host.id);
      expect(activity.FromCollectiveId).to.equal(individual.CollectiveId);
      expect(activity.HostCollectiveId).to.equal(host.id);
      expect(activity.UserId).to.equal(hostAdmin.id);
      expect(activity.data.notify).to.equal(false);
      expect(activity.data.note).to.equal('Watch out');
      expect(activity.data.noteType).to.equal('WARNING');
      expect(await models.FiscalHostNote.count({ where: { CollectiveId: individual.CollectiveId } })).to.equal(0);
    });

    it('does not create an activity when there is no note', async () => {
      const result = await removeNote({ account: { legacyId: individual.CollectiveId } });
      expect(result.errors).to.not.exist;
      expect(result.data.removeFiscalHostNote).to.equal(true);
      const count = await models.Activity.count({
        where: { type: [ActivityTypes.FISCAL_HOST_NOTE_SET, ActivityTypes.FISCAL_HOST_NOTE_REMOVED] },
      });
      expect(count).to.equal(0);
    });
  });

  describe('Account.fiscalHostNote', () => {
    it('returns null when there is no note', async () => {
      const result = await graphqlQueryV2(
        READ_NOTE_QUERY,
        { accountSlug: individual.collective.slug, host: { legacyId: host.id } },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.account.fiscalHostNote).to.be.null;
    });

    it('returns the note to host admins', async () => {
      await setNote({ account: { legacyId: individual.CollectiveId }, type: 'INFO', note: 'Some context' });
      const result = await graphqlQueryV2(
        READ_NOTE_QUERY,
        { accountSlug: individual.collective.slug, host: { legacyId: host.id } },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.account.fiscalHostNote.type).to.equal('INFO');
      expect(result.data.account.fiscalHostNote.note).to.equal('Some context');
      expect(result.data.account.fiscalHostNote.updatedBy.slug).to.equal(hostAdmin.collective.slug);
    });

    it('does not expose the main-profile note without incognito context', async () => {
      const user = await fakeUser();
      const incognitoProfile = await fakeIncognitoProfile(user);
      await setNote({ account: { legacyId: user.CollectiveId }, type: 'WARNING', note: 'Watch this contributor' });

      const result = await graphqlQueryV2(
        READ_NOTE_QUERY,
        { accountSlug: incognitoProfile.slug, host: { legacyId: host.id } },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.account.fiscalHostNote).to.be.null;
    });

    it('surfaces the note through an authorized incognito contribution', async () => {
      const user = await fakeUser();
      const incognitoProfile = await fakeIncognitoProfile(user);
      const hostedCollective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await fakeOrder({
        FromCollectiveId: incognitoProfile.id,
        CollectiveId: hostedCollective.id,
        CreatedByUserId: user.id,
      });
      await setNote({ account: { legacyId: user.CollectiveId }, type: 'WARNING', note: 'Watch this contributor' });

      const result = await graphqlQueryV2(
        INCOGNITO_ORDER_NOTE_QUERY,
        { orderId: order.id, host: { legacyId: host.id } },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.order.fromAccount.fiscalHostNote.note).to.equal('Watch this contributor');
    });

    it('requires the host scope to read notes', async () => {
      await setNote({ account: { legacyId: individual.CollectiveId }, type: 'WARNING', note: 'Watch out' });
      const variables = { accountSlug: individual.collective.slug, host: { legacyId: host.id } };

      const accountOnlyToken = await fakePersonalToken({ user: hostAdmin, scope: [OAuthScopes.account] });
      const denied = await graphqlQueryV2(READ_NOTE_QUERY, variables, hostAdmin, null, null, null, accountOnlyToken);
      expect(denied.errors).to.not.exist;
      expect(denied.data.account.fiscalHostNote).to.be.null;

      const hostToken = await fakePersonalToken({ user: hostAdmin, scope: [OAuthScopes.account, OAuthScopes.host] });
      const allowed = await graphqlQueryV2(READ_NOTE_QUERY, variables, hostAdmin, null, null, null, hostToken);
      expect(allowed.errors).to.not.exist;
      expect(allowed.data.account.fiscalHostNote.note).to.equal('Watch out');
    });

    it('returns null to users that are not admins of the host', async () => {
      const result = await graphqlQueryV2(
        READ_NOTE_QUERY,
        { accountSlug: individual.collective.slug, host: { legacyId: host.id } },
        await fakeUser(),
      );
      expect(result.errors).to.not.exist;
      expect(result.data.account.fiscalHostNote).to.be.null;
    });

    it("does not expose another host's note", async () => {
      const otherHostAdmin = await fakeUser();
      const otherHost = await fakeActiveHost({ admin: otherHostAdmin });
      await setNote({ account: { legacyId: individual.CollectiveId }, type: 'WARNING', note: 'Private note' });

      const result = await graphqlQueryV2(
        READ_NOTE_QUERY,
        { accountSlug: individual.collective.slug, host: { legacyId: otherHost.id } },
        otherHostAdmin,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.account.fiscalHostNote).to.be.null;
    });
  });

  describe('activity visibility', () => {
    beforeEach(async () => {
      await setNote({ account: { legacyId: individual.CollectiveId }, type: 'WARNING', note: 'Private note' });
    });

    it('is listed in the account community stats for host admins', async () => {
      const result = await graphqlQueryV2(
        COMMUNITY_ACTIVITIES_QUERY,
        { accountSlug: individual.collective.slug, host: { legacyId: host.id } },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const activity = result.data.account.communityStats.activities.nodes.find(
        node => node.type === 'FISCAL_HOST_NOTE_SET',
      );
      expect(activity).to.exist;
      expect(activity.data.note).to.equal('Private note');
      expect(activity.data.noteType).to.equal('WARNING');
    });

    it('includes the removal activity for host admins', async () => {
      await removeNote({ account: { legacyId: individual.CollectiveId } });
      const result = await graphqlQueryV2(
        COMMUNITY_ACTIVITIES_QUERY,
        { accountSlug: individual.collective.slug, host: { legacyId: host.id } },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const activity = result.data.account.communityStats.activities.nodes.find(
        node => node.type === 'FISCAL_HOST_NOTE_REMOVED',
      );
      expect(activity).to.exist;
      expect(activity.data.note).to.equal('Private note');
      expect(activity.data.noteType).to.equal('WARNING');
    });

    it('is listed in the host activity feed for host admins', async () => {
      const result = await graphqlQueryV2(ACTIVITIES_QUERY, { account: [{ legacyId: host.id }] }, hostAdmin);
      expect(result.errors).to.not.exist;
      const activity = result.data.activities.nodes.find(node => node.type === 'FISCAL_HOST_NOTE_SET');
      expect(activity).to.exist;
      expect(activity.data.note).to.equal('Private note');
    });

    it('is listed in the hosted collective detail activities query (COLLECTIVE class)', async () => {
      const hostedCollective = await fakeCollective({ HostCollectiveId: host.id });
      await setNote({ account: { legacyId: hostedCollective.id }, type: 'WARNING', note: 'Hosted detail note' });

      const result = await graphqlQueryV2(
        HOSTED_COLLECTIVE_ACTIVITIES_QUERY,
        { id: hostedCollective.publicId },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const activity = result.data.activities.nodes.find(node => node.type === 'FISCAL_HOST_NOTE_SET');
      expect(activity).to.exist;
      expect(activity.data.note).to.equal('Hosted detail note');
    });

    it('is listed in hosted account activities for host admins', async () => {
      const hostedCollective = await fakeCollective({ HostCollectiveId: host.id });
      await setNote({ account: { legacyId: hostedCollective.id }, type: 'WARNING', note: 'Hosted tab note' });

      const result = await graphqlQueryV2(
        ACTIVITIES_QUERY,
        { account: [{ legacyId: hostedCollective.id }], host: { legacyId: host.id } },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const activity = result.data.activities.nodes.find(node => node.type === 'FISCAL_HOST_NOTE_SET');
      expect(activity).to.exist;
      expect(activity.data.note).to.equal('Hosted tab note');
    });

    it('is hidden from collective admins in a hosted account feed', async () => {
      const collectiveAdmin = await fakeUser();
      const hostedCollective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin });
      await setNote({ account: { legacyId: hostedCollective.id }, type: 'WARNING', note: 'Hosted note' });

      const result = await graphqlQueryV2(
        ACTIVITIES_QUERY,
        { account: [{ legacyId: hostedCollective.id }] },
        collectiveAdmin,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.activities.nodes.map(node => node.type)).to.not.include('FISCAL_HOST_NOTE_SET');
    });

    it('is hidden from the flagged account admins in the generic activities query', async () => {
      const result = await graphqlQueryV2(
        ACTIVITIES_QUERY,
        { account: [{ legacyId: individual.CollectiveId }] },
        individual,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.activities.nodes.map(node => node.type)).to.not.include('FISCAL_HOST_NOTE_SET');
    });

    it('is visible to host admins in the host-scoped activities query with its data', async () => {
      const result = await graphqlQueryV2(
        ACTIVITIES_QUERY,
        { account: [{ legacyId: individual.CollectiveId }], host: { legacyId: host.id } },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const activity = result.data.activities.nodes.find(node => node.type === 'FISCAL_HOST_NOTE_SET');
      expect(activity).to.exist;
      expect(activity.data.note).to.equal('Private note');
    });

    it('returns an empty data payload to non host admins', async () => {
      const activity = await models.Activity.findOne({
        where: { type: ActivityTypes.FISCAL_HOST_NOTE_SET },
        order: [['id', 'DESC']],
      });
      const nonAdminReq = { remoteUser: await fakeUser() } as unknown as Parameters<typeof sanitizeActivityData>[0];
      expect(await sanitizeActivityData(nonAdminReq, activity)).to.eql({});
    });

    it('is hidden from other hosts', async () => {
      const otherHostAdmin = await fakeUser();
      const otherHost = await fakeActiveHost({ admin: otherHostAdmin });
      const result = await graphqlQueryV2(
        ACTIVITIES_QUERY,
        { individual: { legacyId: individual.CollectiveId }, host: { legacyId: otherHost.id } },
        otherHostAdmin,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.activities.nodes.map(node => node.type)).to.not.include('FISCAL_HOST_NOTE_SET');
    });
  });
});
