import { expect } from 'chai';
import sinon from 'sinon';

import commentsLoader from '../../../../server/graphql/loaders/comments';
import { sequelize } from '../../../../server/models';
import { CommentType } from '../../../../server/models/Comment';
import { fakeComment, fakeExpense } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

describe('server/graphql/loaders/comments', () => {
  describe('pageByExpense', () => {
    let expense1, expense2, expenseWithoutComments, sandbox;
    const commentsByExpense = {};

    before(async () => {
      await resetTestDB();
      expense1 = await fakeExpense();
      expense2 = await fakeExpense();
      expenseWithoutComments = await fakeExpense();

      for (const expense of [expense1, expense2]) {
        commentsByExpense[expense.id] = [];
        for (let i = 0; i < 3; i++) {
          const createdAt = new Date(Date.UTC(2025, 0, 1 + i));
          commentsByExpense[expense.id].push(await fakeComment({ ExpenseId: expense.id, createdAt }));
        }
      }

      // Noise: a private note and a deleted comment
      await fakeComment({ ExpenseId: expense1.id, type: CommentType.PRIVATE_NOTE, createdAt: new Date('2025-02-01') });
      const deleted = await fakeComment({ ExpenseId: expense1.id, createdAt: new Date('2025-02-02') });
      await deleted.destroy();
    });

    beforeEach(() => {
      sandbox = sinon.createSandbox();
    });

    afterEach(() => {
      sandbox.restore();
    });

    const ids = comments => comments.map(c => c.id);

    it('returns one page per expense with a single query', async () => {
      const querySpy = sandbox.spy(sequelize, 'query');
      const loader = commentsLoader.pageByExpense();
      const keyFor = ExpenseId => ({
        ExpenseId,
        type: [CommentType.COMMENT],
        orderBy: { field: 'createdAt' as const, direction: 'ASC' as const },
        limit: 2,
        offset: 0,
      });
      const [page1, page2, empty] = await Promise.all([
        loader.load(keyFor(expense1.id)),
        loader.load(keyFor(expense2.id)),
        loader.load(keyFor(expenseWithoutComments.id)),
      ]);

      expect(querySpy.callCount).to.eq(1);
      expect(ids(page1)).to.deep.eq(ids(commentsByExpense[expense1.id].slice(0, 2)));
      expect(ids(page2)).to.deep.eq(ids(commentsByExpense[expense2.id].slice(0, 2)));
      expect(empty).to.deep.eq([]);
      expect(page1[0].html).to.eq(commentsByExpense[expense1.id][0].html);
    });

    it('supports offset, direction and types', async () => {
      const loader = commentsLoader.pageByExpense();
      const [descWithOffset, withPrivateNotes] = await Promise.all([
        loader.load({
          ExpenseId: expense1.id,
          type: [CommentType.COMMENT],
          orderBy: { field: 'createdAt' as const, direction: 'DESC' as const },
          limit: 10,
          offset: 1,
        }),
        loader.load({
          ExpenseId: expense1.id,
          type: [CommentType.COMMENT, CommentType.PRIVATE_NOTE],
          orderBy: { field: 'createdAt' as const, direction: 'ASC' as const },
          limit: 10,
          offset: 0,
        }),
      ]);

      expect(ids(descWithOffset)).to.deep.eq(ids([...commentsByExpense[expense1.id]].reverse().slice(1)));
      expect(withPrivateNotes).to.have.length(4); // 3 comments + 1 private note, deleted comment excluded
      expect(withPrivateNotes[3].type).to.eq(CommentType.PRIVATE_NOTE);
    });
  });
});
