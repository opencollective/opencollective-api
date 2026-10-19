import { expect } from 'chai';

import { activities } from '../../../../../server/constants';
import ExpenseType from '../../../../../server/constants/expense-type';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import { Expense } from '../../../../../server/models';
import { ExpenseLockableFields } from '../../../../../server/models/Expense';
import { PayoutMethodTypes } from '../../../../../server/models/PayoutMethod';
import {
  fakeActiveHost,
  fakeOrganization,
  fakePayoutMethod,
  fakePersonalToken,
  fakeUploadedFile,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, personalTokenGraphqlQueryV2, resetTestDB } from '../../../../utils';

const editExpenseMutation = `
  mutation EditInvitedExpense($expense: ExpenseUpdateInput!, $draftKey: String) {
    editExpense(expense: $expense, draftKey: $draftKey) {
      status
      payee { legacyId }
    }
  }
`;

const createFixture = async () => {
  const author = await fakeUser();
  const invitee = await fakeUser();
  const host = await fakeActiveHost({ admin: author, currency: 'USD' });
  const organization = await fakeOrganization({ admin: invitee, currency: 'USD' });
  const payoutMethod = await fakePayoutMethod({
    CollectiveId: organization.id,
    CreatedByUserId: invitee.id,
    type: PayoutMethodTypes.BANK_ACCOUNT,
    currency: 'USD',
    data: { currency: 'USD' },
  });
  const invoiceFile = await fakeUploadedFile({
    kind: 'EXPENSE_INVOICE',
    fileType: 'application/pdf',
    CreatedByUserId: invitee.id,
  });
  const draft = await Expense.create({
    UserId: author.id,
    lastEditedById: author.id,
    CollectiveId: host.id,
    FromCollectiveId: author.CollectiveId,
    status: 'DRAFT',
    type: ExpenseType.INVOICE,
    currency: 'USD',
    amount: 2500,
    description: 'Test service',
    incurredAt: new Date('2025-01-01T00:00:00Z'),
    data: {
      draftKey: 'test-invitation-key',
      payee: { email: invitee.email.toUpperCase() },
      items: [{ description: 'Test service', amount: 2500, currency: 'USD' }],
      isNewExpenseFlow: true,
    },
  });
  const input = {
    id: idEncode(draft.id, IDENTIFIER_TYPES.EXPENSE),
    payee: { slug: organization.slug },
    reference: 'TEST-001',
    payoutMethod: { id: idEncode(payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD) },
    invoiceFile: { url: invoiceFile.url },
    items: [{ description: 'Test service', amount: 2500, incurredAt: '2025-01-01T00:00:00Z' }],
  };
  return { author, invitee, host, organization, payoutMethod, invoiceFile, draft, input };
};

describe('editExpense email draft invitations', () => {
  before(async () => {
    await resetTestDB();
  });

  for (const draftKey of [undefined, 'test-invitation-key']) {
    it(`lets the authenticated email invitee submit for their organization ${draftKey ? 'with' : 'without'} a key`, async () => {
      const { invitee, organization, invoiceFile, payoutMethod, draft, input } = await createFixture();
      const result = await graphqlQueryV2(editExpenseMutation, { expense: input, draftKey }, invitee);

      expect(result.errors).to.not.exist;
      expect(result.data.editExpense.status).to.equal('PENDING');
      expect(result.data.editExpense.payee.legacyId).to.equal(organization.id);
      await draft.reload();
      expect(draft.UserId).to.equal(invitee.id);
      expect(draft.lastEditedById).to.equal(invitee.id);
      expect(draft.FromCollectiveId).to.equal(organization.id);
      expect(draft.InvoiceFileId).to.equal(invoiceFile.id);
      expect(draft.PayoutMethodId).to.equal(payoutMethod.id);
      expect(draft.reference).to.equal('TEST-001');
      expect(draft.data.draftKey).to.be.undefined;
      expect(await draft.getItems()).to.have.length(1);
      const submittedActivities = await draft.getActivities({ where: { type: activities.COLLECTIVE_EXPENSE_CREATED } });
      expect(submittedActivities).to.have.length(1);
      expect(submittedActivities[0].UserId).to.equal(invitee.id);
    });
  }

  it('lets the email invitee submit with their personal account without a key', async () => {
    const { invitee, draft, input } = await createFixture();
    const result = await graphqlQueryV2(
      editExpenseMutation,
      { expense: { ...input, payee: { slug: invitee.collective.slug }, payoutMethod: null } },
      invitee,
    );

    expect(result.errors).to.not.exist;
    expect(result.data.editExpense.status).to.equal('PENDING');
    await draft.reload();
    expect(draft.FromCollectiveId).to.equal(invitee.CollectiveId);
    expect(draft.UserId).to.equal(invitee.id);
  });

  it('keeps author edits to an email invitation as a draft', async () => {
    const { author, draft, input } = await createFixture();
    const result = await graphqlQueryV2(
      editExpenseMutation,
      { expense: { id: input.id, description: 'Updated test service' } },
      author,
    );

    expect(result.errors).to.not.exist;
    expect(result.data.editExpense.status).to.equal('DRAFT');
    await draft.reload();
    expect(draft.description).to.equal('Updated test service');
    expect(draft.UserId).to.equal(author.id);
    expect(draft.data.draftKey).to.equal('test-invitation-key');
  });

  for (const draftKey of [undefined, 'test-invitation-key']) {
    it(`keeps description-only author edits as drafts when the author is also the email invitee ${draftKey ? 'with' : 'without'} a key`, async () => {
      const { author, draft, input } = await createFixture();
      await draft.update({ data: { ...draft.data, payee: { email: author.email.toUpperCase() } } });
      const result = await graphqlQueryV2(
        editExpenseMutation,
        { expense: { id: input.id, description: 'Updated test service' }, draftKey },
        author,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.editExpense.status).to.equal('DRAFT');
      await draft.reload();
      expect(draft.description).to.equal('Updated test service');
      expect(draft.UserId).to.equal(author.id);
      expect(draft.FromCollectiveId).to.equal(author.CollectiveId);
      expect(draft.data.draftKey).to.equal('test-invitation-key');
      expect(await draft.getActivities({ where: { type: activities.COLLECTIVE_EXPENSE_CREATED } })).to.have.length(0);
    });
  }

  it('requires authentication when submitting without a key', async () => {
    const { draft, input } = await createFixture();
    const result = await graphqlQueryV2(editExpenseMutation, { expense: input });

    expect(result.errors?.[0].message).to.equal('You need to be logged in to edit an expense');
    await draft.reload();
    expect(draft.status).to.equal('DRAFT');
  });

  it('requires the expenses scope even when the token user matches the invited email', async () => {
    const { invitee, draft, input } = await createFixture();
    const token = await fakePersonalToken({ user: invitee, scope: [] });
    const result = await personalTokenGraphqlQueryV2(editExpenseMutation, { expense: input }, token);

    expect(result.errors?.[0].message).to.equal(
      'The Personal Token is not allowed for operations in scope "expenses".',
    );
    await draft.reload();
    expect(draft.status).to.equal('DRAFT');
  });

  it('enforces the selected recipient account two-factor policy', async () => {
    const { invitee, organization, draft, input } = await createFixture();
    await organization.update({ data: { ...organization.data, policies: { REQUIRE_2FA_FOR_ADMINS: true } } });
    const result = await graphqlQueryV2(editExpenseMutation, { expense: input }, invitee);

    expect(result.errors?.[0].message).to.equal('Two factor authentication must be configured');
    await draft.reload();
    expect(draft.status).to.equal('DRAFT');
  });

  it('rejects an unrelated user without a key', async () => {
    const { draft, input } = await createFixture();
    const stranger = await fakeUser();
    const result = await graphqlQueryV2(
      editExpenseMutation,
      { expense: { ...input, payee: { slug: stranger.collective.slug }, payoutMethod: null, invoiceFile: null } },
      stranger,
    );

    expect(result.errors).to.exist;
    expect(result.data).to.be.null;
    await draft.reload();
    expect(draft.status).to.equal('DRAFT');
    expect(await draft.getItems()).to.have.length(0);
  });

  it('rejects an unrelated user with an incorrect key', async () => {
    const { draft, input } = await createFixture();
    const stranger = await fakeUser();
    const result = await graphqlQueryV2(
      editExpenseMutation,
      {
        expense: { ...input, payee: { slug: stranger.collective.slug }, payoutMethod: null, invoiceFile: null },
        draftKey: 'incorrect-key',
      },
      stranger,
    );

    expect(result.errors?.[0].message).to.equal('You need to submit the right draft key to edit this expense');
    await draft.reload();
    expect(draft.status).to.equal('DRAFT');
  });

  it('preserves submission using a valid invitation key for a different signed-in user', async () => {
    const { input } = await createFixture();
    const keyHolder = await fakeUser();
    const result = await graphqlQueryV2(
      editExpenseMutation,
      {
        expense: { ...input, payee: { slug: keyHolder.collective.slug }, payoutMethod: null, invoiceFile: null },
        draftKey: 'test-invitation-key',
      },
      keyHolder,
    );

    expect(result.errors).to.not.exist;
    expect(result.data.editExpense.status).to.equal('PENDING');
    expect(result.data.editExpense.payee.legacyId).to.equal(keyHolder.CollectiveId);
  });

  it('requires the email invitee to administer the selected recipient', async () => {
    const { invitee, draft, input } = await createFixture();
    const otherOrganization = await fakeOrganization();
    const result = await graphqlQueryV2(
      editExpenseMutation,
      { expense: { ...input, payee: { slug: otherOrganization.slug } } },
      invitee,
    );

    expect(result.errors?.[0].message).to.equal(
      'User needs to be an admin of the payee (or its fiscal host) to submit an expense on their behalf',
    );
    await draft.reload();
    expect(draft.status).to.equal('DRAFT');
  });

  it('preserves locked recipient fields for an email invitee without a key', async () => {
    const { invitee, draft, input } = await createFixture();
    await draft.update({ data: { ...draft.data, lockedFields: [ExpenseLockableFields.PAYEE] } });
    const result = await graphqlQueryV2(editExpenseMutation, { expense: input }, invitee);

    expect(result.errors?.[0].message).to.equal('Payee cannot be edited');
    await draft.reload();
    expect(draft.status).to.equal('DRAFT');
  });

  it('rejects a payout method belonging to a different recipient account', async () => {
    const { invitee, draft, input } = await createFixture();
    const personalPayoutMethod = await fakePayoutMethod({
      CollectiveId: invitee.CollectiveId,
      CreatedByUserId: invitee.id,
      currency: 'USD',
    });
    const result = await graphqlQueryV2(
      editExpenseMutation,
      {
        expense: { ...input, payoutMethod: { id: idEncode(personalPayoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD) } },
      },
      invitee,
    );

    expect(result.errors?.[0].message).to.equal('This payout method cannot be used for this collective');
    await draft.reload();
    expect(draft.status).to.equal('DRAFT');
    expect(draft.PayoutMethodId).to.be.null;
    expect(draft.InvoiceFileId).to.be.null;
  });
});
