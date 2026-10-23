/**
 * PostgreSQL search provider: Comments (opencollective#8942).
 *
 * These tests go through the GraphQL V2 `search` query with real PostgreSQL fixtures and never need an OpenSearch
 * cluster. Fixtures use made-up words so that tests don't match each other's rows.
 */

import { expect } from 'chai';
import gql from 'fake-tag';
import sinon from 'sinon';

import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import PlatformConstants from '../../../../../server/constants/platform';
import { idEncode } from '../../../../../server/graphql/v2/identifiers';
import * as OpenSearchClientLib from '../../../../../server/lib/open-search/client';
import { Collective, Expense, sequelize, Update, User } from '../../../../../server/models';
import Comment, { CommentType } from '../../../../../server/models/Comment';
import {
  fakeActiveHost,
  fakeCollective,
  fakeComment,
  fakeConversation,
  fakeExpense,
  fakeHostApplication,
  fakeOrder,
  fakeOrganization,
  fakeProject,
  fakeUpdate,
  fakeUser,
  fakeUserToken,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, resetCaches, resetTestDB } from '../../../../utils';

const commentsSearchQuery = gql`
  query PostgresCommentsSearch(
    $searchTerm: String!
    $account: AccountReferenceInput
    $host: AccountReferenceInput
    $limit: Int
    $offset: Int
  ) {
    search(searchTerm: $searchTerm, backend: POSTGRES, account: $account, host: $host) {
      results {
        comments(limit: $limit, offset: $offset) {
          maxScore
          scores {
            id
            score
          }
          collection {
            totalCount
            offset
            nodes {
              id
            }
          }
        }
      }
    }
  }
`;

type CommentsSearchVariables = {
  account?: { slug: string };
  host?: { slug: string };
  limit?: number;
  offset?: number;
};

const searchComments = (searchTerm: string, variables: CommentsSearchVariables = {}, remoteUser: User = null) =>
  graphqlQueryV2(commentsSearchQuery, { searchTerm, ...variables }, remoteUser);

const getComments = async (searchTerm: string, variables: CommentsSearchVariables = {}, remoteUser: User = null) => {
  const result = await searchComments(searchTerm, variables, remoteUser);
  expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
  return result.data.search.results.comments;
};

/** GraphQL IDs of the matching Comments, in ranking order */
const getCommentIds = async (searchTerm: string, variables: CommentsSearchVariables = {}, remoteUser = null) => {
  const comments = await getComments(searchTerm, variables, remoteUser);
  return comments.collection.nodes.map(node => node.id);
};

const setExpenseDeletedAt = (expense: Expense, deletedAt: Date | null) =>
  sequelize.query(`UPDATE "Expenses" SET "deletedAt" = :deletedAt WHERE id = :id`, {
    replacements: { deletedAt, id: expense.id },
  });

const gqlId = (comment: { id: number }) => idEncode(comment.id, 'comment');

describe('server/graphql/v2/query/SearchQuery (PostgreSQL, Comments)', () => {
  let sandbox: sinon.SinonSandbox;
  let hostAdmin: User, rootUser: User;
  let host: Collective, collective: Collective;

  before(async () => {
    await resetTestDB();
    await resetCaches(); // Search rate-limit counters are keyed by user ID, which the DB reset reuses
    rootUser = await fakeUser({ data: { isRoot: true } });
    const platform = await fakeOrganization({ id: PlatformConstants.PlatformCollectiveId, name: 'Platform' });
    await platform.addUserWithRole(rootUser, 'ADMIN');
    hostAdmin = await fakeUser();
    host = await fakeActiveHost({ name: 'Pangolin Host', slug: 'pangolin-host', admin: hostAdmin });
    collective = await fakeCollective({ slug: 'pangolin-collective', HostCollectiveId: host.id });
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(OpenSearchClientLib, 'isOpenSearchConfigured').returns(false);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('matching', () => {
    it('finds an Expense Comment by its text', async () => {
      const expense = await fakeExpense({ CollectiveId: collective.id, HostCollectiveId: host.id });
      const comment = await fakeComment({
        CollectiveId: collective.id,
        ExpenseId: expense.id,
        html: '<p>The quokka receipt is attached</p>',
      });

      const comments = await getComments('quokka', {}, hostAdmin);
      expect(comments.collection.totalCount).to.eq(1);
      expect(comments.collection.nodes).to.deep.eq([{ id: gqlId(comment) }]);
      expect(comments.maxScore).to.eq(comments.scores[0].score);
    });

    it('matches the HTML body as plain text, ignoring case and accents, and requires all the words', async () => {
      const expense = await fakeExpense({ CollectiveId: collective.id, HostCollectiveId: host.id });
      const comment = await fakeComment({
        CollectiveId: collective.id,
        ExpenseId: expense.id,
        html: '<p>Crème <strong>brûlée</strong>&nbsp;fundraisers</p><img src="https://example.com/wallabyimage.png"/>',
      });

      for (const term of ['creme brulee', 'CRÈME BRÛLÉE', 'brulee fundraiser']) {
        expect(await getCommentIds(term, {}, hostAdmin), term).to.deep.eq([gqlId(comment)]);
      }
      for (const term of ['creme unrelatedword', 'strong', 'wallabyimage', 'nbsp']) {
        expect(await getCommentIds(term, {}, hostAdmin), term).to.deep.eq([]);
      }
    });

    it('finds exact identifiers, ranked above words', async () => {
      const expense = await fakeExpense({ CollectiveId: collective.id, HostCollectiveId: host.id });
      const comment = await fakeComment({ CollectiveId: collective.id, ExpenseId: expense.id });
      for (const term of [String(comment.id), `#${comment.id}`, comment.publicId, gqlId(comment)]) {
        const comments = await getComments(term, {}, hostAdmin);
        expect(
          comments.collection.nodes.map(n => n.id),
          term,
        ).to.include(gqlId(comment));
        expect(comments.scores[0], term).to.deep.eq({ id: gqlId(comment), score: 5000 });
      }
    });

    it('reflects live text changes and deletions', async () => {
      const expense = await fakeExpense({ CollectiveId: collective.id, HostCollectiveId: host.id });
      const comment = await fakeComment({
        CollectiveId: collective.id,
        ExpenseId: expense.id,
        html: '<p>Iguanodon</p>',
      });
      expect(await getCommentIds('iguanodon', {}, hostAdmin)).to.deep.eq([gqlId(comment)]);
      await comment.update({ html: '<p>Stegosaurus</p>' });
      expect(await getCommentIds('iguanodon', {}, hostAdmin)).to.deep.eq([]);
      expect(await getCommentIds('stegosaurus', {}, hostAdmin)).to.deep.eq([gqlId(comment)]);
      await comment.destroy();
      expect(await getCommentIds('stegosaurus', {}, hostAdmin)).to.deep.eq([]);
    });
  });

  describe('ranking and pagination alongside other entities', () => {
    const mixedSearchQuery = gql`
      query PostgresMixedCommentsSearch($searchTerm: String!, $commentsLimit: Int, $commentsOffset: Int) {
        search(searchTerm: $searchTerm, backend: POSTGRES) {
          results {
            accounts {
              maxScore
              collection {
                totalCount
              }
            }
            comments(limit: $commentsLimit, offset: $commentsOffset) {
              maxScore
              highlights
              scores {
                id
                score
              }
              collection {
                totalCount
                nodes {
                  id
                }
              }
            }
          }
        }
      }
    `;

    let account: Collective;
    const tied: Comment[] = [];

    before(async () => {
      account = await fakeCollective({ name: 'Tuatara', slug: 'tuatara-group', HostCollectiveId: host.id });
      const expense = await fakeExpense({ CollectiveId: account.id, HostCollectiveId: host.id });
      for (let i = 0; i < 3; i++) {
        tied.push(await fakeComment({ CollectiveId: account.id, ExpenseId: expense.id, html: `<p>Tuatara ${i}</p>` }));
      }
    });

    const search = async (variables: Record<string, number> = {}) => {
      const result = await graphqlQueryV2(mixedSearchQuery, { searchTerm: 'tuatara', ...variables }, hostAdmin);
      expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
      return result.data.search.results;
    };

    it('ranks an exact Account name above Comment words, without highlights', async () => {
      const { accounts, comments } = await search();
      expect(accounts.collection.totalCount).to.eq(1);
      expect(accounts.maxScore).to.be.above(comments.maxScore);
      expect(comments.maxScore).to.be.within(3000, 3999);
      Object.values(comments.highlights).forEach((highlight: { fields?: unknown }) => {
        expect(highlight.fields).to.not.exist;
      });
    });

    it('breaks ties by descending ID, with exact totals and offset-independent maxScores on every page', async () => {
      const expected = [...tied].reverse().map(gqlId);
      const firstPage = await search({ commentsLimit: 2 });
      const secondPage = await search({ commentsLimit: 2, commentsOffset: 2 });
      const emptyPage = await search({ commentsLimit: 2, commentsOffset: 10 });
      expect(
        [...firstPage.comments.collection.nodes, ...secondPage.comments.collection.nodes].map(n => n.id),
      ).to.deep.eq(expected);
      expect(emptyPage.comments.collection.nodes).to.be.empty;
      for (const page of [firstPage, secondPage, emptyPage]) {
        expect(page.comments.collection.totalCount).to.eq(3);
        expect(page.comments.maxScore).to.eq(firstPage.comments.scores[0].score);
      }
    });
  });

  describe('Comment types and administrators', () => {
    let collectiveAdmin: User, projectAdmin: User, payee: User, randomUser: User;
    let project: Collective;
    let expenseComment: Comment, expenseNote: Comment, projectExpenseComment: Comment;

    before(async () => {
      collectiveAdmin = await fakeUser();
      projectAdmin = await fakeUser();
      payee = await fakeUser();
      randomUser = await fakeUser();

      const hosted = await fakeCollective({
        slug: 'okapi-collective',
        HostCollectiveId: host.id,
        admin: collectiveAdmin,
      });
      project = await fakeProject({ slug: 'okapi-project', ParentCollectiveId: hosted.id, admin: projectAdmin });
      const expense = await fakeExpense({
        CollectiveId: hosted.id,
        HostCollectiveId: host.id,
        FromCollectiveId: payee.CollectiveId,
        UserId: payee.id,
      });
      const projectExpense = await fakeExpense({ CollectiveId: project.id, HostCollectiveId: host.id });
      expenseComment = await fakeComment({
        CollectiveId: hosted.id,
        FromCollectiveId: payee.CollectiveId,
        ExpenseId: expense.id,
        html: '<p>Okapi comment</p>',
      });
      expenseNote = await fakeComment({
        CollectiveId: hosted.id,
        ExpenseId: expense.id,
        type: CommentType.PRIVATE_NOTE,
        html: '<p>Okapi private note</p>',
      });
      projectExpenseComment = await fakeComment({
        CollectiveId: project.id,
        ExpenseId: projectExpense.id,
        html: '<p>Okapi project comment</p>',
      });
    });

    it('applies Comment-type and administrator rules', async () => {
      const all = [expenseComment, expenseNote, projectExpenseComment].map(gqlId);
      const expectations: Array<[string, User | null, string[]]> = [
        ['unauthenticated', null, []],
        ['random user', randomUser, []],
        ['payee (author)', payee, [gqlId(expenseComment)]],
        ['project admin', projectAdmin, [gqlId(projectExpenseComment)]],
        [
          'collective admin (and parent of the project)',
          collectiveAdmin,
          [expenseComment, projectExpenseComment].map(gqlId),
        ],
        ['host admin', hostAdmin, all],
        ['root', rootUser, all],
      ];

      for (const [label, user, expected] of expectations) {
        const comments = await getComments('okapi', {}, user);
        expect(
          comments.collection.nodes.map(n => n.id),
          label,
        ).to.have.members(expected);
        expect(comments.collection.totalCount, label).to.eq(expected.length);
      }
    });

    it('never lets private notes affect matching, totals or scores for other users', async () => {
      for (const user of [payee, collectiveAdmin, randomUser]) {
        const comments = await getComments('okapi private note', {}, user);
        expect(comments.collection.totalCount).to.eq(0);
        expect(comments.maxScore).to.eq(0);
        expect((await getComments(String(expenseNote.id), {}, user)).collection.totalCount).to.eq(0);
      }
      expect(await getCommentIds('okapi private note', {}, hostAdmin)).to.deep.eq([gqlId(expenseNote)]);
    });

    it('reflects live Comment-type changes', async () => {
      await expenseComment.update({ type: CommentType.PRIVATE_NOTE });
      try {
        expect(await getCommentIds('okapi', {}, collectiveAdmin)).to.deep.eq([gqlId(projectExpenseComment)]);
        expect(await getCommentIds('okapi', {}, payee)).to.deep.eq([]);
        expect(await getCommentIds('okapi', {}, hostAdmin)).to.include(gqlId(expenseComment));
      } finally {
        await expenseComment.update({ type: CommentType.COMMENT });
      }
      expect(await getCommentIds('okapi', {}, payee)).to.deep.eq([gqlId(expenseComment)]);
    });
  });

  describe('scopes', () => {
    let author: User, hosted: Collective, project: Collective;
    let collectiveComment: Comment, projectComment: Comment, applicationComment: Comment;

    before(async () => {
      author = await fakeUser();
      hosted = await fakeCollective({ slug: 'kakapo-collective', HostCollectiveId: host.id });
      project = await fakeProject({ slug: 'kakapo-project', ParentCollectiveId: hosted.id });
      const expense = await fakeExpense({ CollectiveId: hosted.id, HostCollectiveId: host.id });
      const projectExpense = await fakeExpense({ CollectiveId: project.id, HostCollectiveId: host.id });
      collectiveComment = await fakeComment({
        CollectiveId: hosted.id,
        FromCollectiveId: author.CollectiveId,
        ExpenseId: expense.id,
        html: 'Kakapo',
      });
      projectComment = await fakeComment({ CollectiveId: project.id, ExpenseId: projectExpense.id, html: 'Kakapo' });

      // An application of an account hosted elsewhere: its host is the application's host
      const otherHost = await fakeActiveHost({ slug: 'kakapo-other-host' });
      const applicant = await fakeCollective({ slug: 'kakapo-applicant', HostCollectiveId: otherHost.id });
      const application = await fakeHostApplication({ CollectiveId: applicant.id, HostCollectiveId: host.id });
      applicationComment = await fakeComment({
        CollectiveId: applicant.id,
        HostApplicationId: application.id,
        html: 'Kakapo',
      });
    });

    it('scopes Comments to the account, its children and its own Comments', async () => {
      expect(await getCommentIds('kakapo', { account: { slug: project.slug } }, rootUser)).to.deep.eq([
        gqlId(projectComment),
      ]);
      expect(await getCommentIds('kakapo', { account: { slug: hosted.slug } }, rootUser)).to.have.members(
        [collectiveComment, projectComment].map(gqlId),
      );
      const authorProfile = await Collective.findByPk(author.CollectiveId);
      expect(await getCommentIds('kakapo', { account: { slug: authorProfile.slug } }, rootUser)).to.deep.eq([
        gqlId(collectiveComment),
      ]);
    });

    it('scopes Comments to the effective host, and intersects account and host scopes', async () => {
      expect(await getCommentIds('kakapo', { host: { slug: host.slug } }, rootUser)).to.have.members(
        [collectiveComment, projectComment, applicationComment].map(gqlId),
      );
      expect(await getCommentIds('kakapo', { host: { slug: 'kakapo-other-host' } }, rootUser)).to.deep.eq([]);
      expect(
        await getCommentIds('kakapo', { host: { slug: host.slug }, account: { slug: project.slug } }, rootUser),
      ).to.deep.eq([gqlId(projectComment)]);
      expect(
        await getCommentIds(
          'kakapo',
          { host: { slug: 'kakapo-other-host' }, account: { slug: hosted.slug } },
          rootUser,
        ),
      ).to.deep.eq([]);
    });
  });

  describe('commented entities', () => {
    let collectiveAdmin: User, fan: User;
    let hosted: Collective, draft: Update, expense: Expense;
    let draftComment: Comment,
      privateUpdateComment: Comment,
      publicUpdateComment: Comment,
      conversationComment: Comment;
    let orderNote: Comment, applicationComment: Comment, applicationNote: Comment;

    before(async () => {
      collectiveAdmin = await fakeUser();
      fan = await fakeUser();
      hosted = await fakeCollective({ slug: 'numbat-collective', HostCollectiveId: host.id, admin: collectiveAdmin });

      const fromFan = { CollectiveId: hosted.id, FromCollectiveId: fan.CollectiveId };
      draft = await fakeUpdate({ CollectiveId: hosted.id, publishedAt: null });
      const privateUpdate = await fakeUpdate({ CollectiveId: hosted.id, publishedAt: new Date(), isPrivate: true });
      const publicUpdate = await fakeUpdate({ CollectiveId: hosted.id, publishedAt: new Date() });
      draftComment = await fakeComment({ ...fromFan, UpdateId: draft.id, html: 'Numbat draft' });
      privateUpdateComment = await fakeComment({ ...fromFan, UpdateId: privateUpdate.id, html: 'Numbat private' });
      publicUpdateComment = await fakeComment({ ...fromFan, UpdateId: publicUpdate.id, html: 'Numbat public' });

      const conversation = await fakeConversation({ CollectiveId: hosted.id });
      conversationComment = await fakeComment({ ...fromFan, ConversationId: conversation.id, html: 'Numbat chat' });

      const order = await fakeOrder({ CollectiveId: hosted.id });
      orderNote = await fakeComment({
        CollectiveId: hosted.id,
        OrderId: order.id,
        type: CommentType.PRIVATE_NOTE,
        html: 'Numbat order note',
      });
      // Only private notes are allowed on Orders: never visible
      await fakeComment({ ...fromFan, OrderId: order.id, html: 'Numbat order comment' });

      const application = await fakeHostApplication({ CollectiveId: hosted.id, HostCollectiveId: host.id });
      applicationComment = await fakeComment({ ...fromFan, HostApplicationId: application.id, html: 'Numbat apply' });
      applicationNote = await fakeComment({
        CollectiveId: hosted.id,
        HostApplicationId: application.id,
        type: CommentType.PRIVATE_NOTE,
        html: 'Numbat apply note',
      });

      expense = await fakeExpense({ CollectiveId: hosted.id, HostCollectiveId: host.id });
      await fakeComment({ ...fromFan, ExpenseId: expense.id, html: 'Numbat expense' });
      // Comments on deleted entities are never visible. `destroy` also deletes the Comments: mark the Expense alone.
      await setExpenseDeletedAt(expense, new Date());
    });

    it('applies the visibility of the commented entity', async () => {
      const expectations: Array<[string, User, Comment[]]> = [
        ['author', fan, [publicUpdateComment, conversationComment]],
        [
          'collective admin',
          collectiveAdmin,
          [draftComment, privateUpdateComment, publicUpdateComment, conversationComment, applicationComment],
        ],
        [
          'host admin',
          hostAdmin,
          [
            privateUpdateComment,
            publicUpdateComment,
            conversationComment,
            orderNote,
            applicationComment,
            applicationNote,
          ],
        ],
        [
          'root',
          rootUser,
          [
            draftComment,
            privateUpdateComment,
            publicUpdateComment,
            conversationComment,
            orderNote,
            applicationComment,
            applicationNote,
          ],
        ],
      ];

      for (const [label, user, expected] of expectations) {
        const comments = await getComments('numbat', {}, user);
        expect(
          comments.collection.nodes.map(n => n.id),
          label,
        ).to.have.members(expected.map(gqlId));
        expect(comments.collection.totalCount, label).to.eq(expected.length);
      }
    });

    it('reflects live publication and deletion of the commented entity', async () => {
      expect(await getCommentIds('numbat draft', {}, hostAdmin)).to.deep.eq([]);
      await draft.update({ publishedAt: new Date() });
      expect(await getCommentIds('numbat draft', {}, hostAdmin)).to.deep.eq([gqlId(draftComment)]);
      expect(await getCommentIds('numbat draft', {}, fan)).to.deep.eq([gqlId(draftComment)]);
      await draft.update({ isPrivate: true });
      expect(await getCommentIds('numbat draft', {}, fan)).to.deep.eq([]);
      await draft.destroy();
      expect(await getCommentIds('numbat draft', {}, rootUser)).to.deep.eq([]);

      expect(await getCommentIds('numbat expense', {}, rootUser)).to.deep.eq([]);
      await setExpenseDeletedAt(expense, null);
      try {
        expect(await getCommentIds('numbat expense', {}, hostAdmin)).to.have.length(1);
      } finally {
        await setExpenseDeletedAt(expense, new Date());
      }
    });

    it('requires the OAuth scope of the commented entity where its GraphQL rules do', async () => {
      const search = async (scope: OAuthScopes[]) => {
        const token = await fakeUserToken({ scope, UserId: hostAdmin.id });
        const result = await oAuthGraphqlQueryV2(commentsSearchQuery, { searchTerm: 'numbat' }, token);
        expect(result.errors, JSON.stringify(result.errors)).to.not.exist;
        return result.data.search.results.comments.collection.nodes.map(n => n.id);
      };

      // Public Updates, Conversations and Host Applications need no scope; private Updates, Orders do
      const unscoped = [publicUpdateComment, conversationComment, applicationComment, applicationNote].map(gqlId);
      expect(await search([OAuthScopes.account])).to.have.members(unscoped);
      expect(await search([OAuthScopes.updates])).to.have.members([...unscoped, gqlId(privateUpdateComment)]);
      expect(await search([OAuthScopes.orders])).to.have.members([...unscoped, gqlId(orderNote)]);

      // Expenses need the expenses scope
      const otherExpense = await fakeExpense({ CollectiveId: hosted.id, HostCollectiveId: host.id });
      const expenseComment = await fakeComment({ CollectiveId: hosted.id, ExpenseId: otherExpense.id, html: 'Numbat' });
      expect(await search([OAuthScopes.account])).to.not.include(gqlId(expenseComment));
      expect(await search([OAuthScopes.expenses])).to.include(gqlId(expenseComment));
      await expenseComment.destroy();
    });

    it('never searches Comments of private or deleted Accounts, even for root', async () => {
      await hosted.update({ isPrivate: true });
      try {
        expect(await getCommentIds('numbat', {}, rootUser)).to.deep.eq([]);
        expect(await getCommentIds('numbat', {}, collectiveAdmin)).to.deep.eq([]);
      } finally {
        await hosted.update({ isPrivate: false });
      }

      // The commented entity's Account is checked too, when it differs from the Comment's
      const otherAccount = await fakeCollective({ HostCollectiveId: host.id });
      const otherExpense = await fakeExpense({ CollectiveId: otherAccount.id, HostCollectiveId: host.id });
      const comment = await fakeComment({ CollectiveId: hosted.id, ExpenseId: otherExpense.id, html: 'Wombatmoved' });
      expect(await getCommentIds('wombatmoved', {}, rootUser)).to.deep.eq([gqlId(comment)]);
      await otherAccount.destroy();
      expect(await getCommentIds('wombatmoved', {}, rootUser)).to.deep.eq([]);
    });
  });
});
