import config from 'config';
import type { Transaction } from 'sequelize';
import sharp from 'sharp';
import type { z } from 'zod';

import { CollectiveType } from '../constants/collectives';
import type { SupportedCurrency } from '../constants/currencies';
import expenseStatus from '../constants/expense-status';
import expenseType from '../constants/expense-type';
import type { FileKind } from '../constants/file-kind';
import POLICIES, { type UseVendorPolicyValue } from '../constants/policies';
import roles from '../constants/roles';
import { createAccountAdminMembers } from '../lib/account-admins';
import { TOKEN_EXPIRATION_SESSION } from '../lib/auth';
import { checkS3Configured, uploadToS3 } from '../lib/awsS3';
import {
  Collective,
  Expense,
  ExpenseAttachedFile,
  ExpenseItem,
  Member,
  PayoutMethod,
  UploadedFile,
  User,
} from '../models';
import { PayoutMethodTypes } from '../models/PayoutMethod';
import type { SUPPORTED_FILE_TYPES } from '../models/UploadedFile';

/**
 * Small prerequisite builders shared by the named recipes. Every write joins the
 * recipe transaction, so a request commits its whole graph with its receipt or
 * nothing at all. Builders arrange starting state only: they bypass mutations,
 * send no mail and record no activity a journey could mistake for its own.
 */
type FixtureContext = {
  transaction: Transaction;
  /** sha256 of the owner run, attempt identity and request ID. */
  key: string;
  attempt: Record<string, unknown>;
  requestId: string;
  /** Attempt-unique slug/identifier for a labelled part of the graph. */
  slug: (label: string) => string;
  /** Short attempt-unique suffix for human-readable names. */
  tag: string;
  /** Throws (and rolls back) once the requesting client has gone away. */
  checkConnection: () => void;
};

/**
 * A named recipe validates its own inputs and arranges one prerequisite graph
 * inside the request transaction. The protocol adds the echoed request identity
 * and the durable receipt around whatever references it returns.
 */
export type Recipe = {
  inputs: z.ZodType;
  build: (ctx: FixtureContext, inputs: unknown) => Promise<Record<string, unknown>>;
};
export const defineRecipe = <Schema extends z.ZodType>(recipe: {
  inputs: Schema;
  build: (ctx: FixtureContext, inputs: z.output<Schema>) => Promise<Record<string, unknown>>;
}): Recipe => recipe as Recipe;

type AccountSettings = Record<string, unknown>;

/** Stored on every arranged Account, so a retained row names the attempt and request that created it. */
export const arrangedBy = (ctx: Pick<FixtureContext, 'attempt' | 'requestId'>) => ({
  e2eAttempt: ctx.attempt,
  e2eRequestId: ctx.requestId,
});

/** The membership that makes an Account's fiscal host its host, as hosting leaves it. */
const addHostMember = (ctx: FixtureContext, account: Collective, creator: User) =>
  Member.create(
    {
      CollectiveId: account.id,
      MemberCollectiveId: account.HostCollectiveId,
      role: roles.HOST,
      CreatedByUserId: creator.id,
    },
    { transaction: ctx.transaction },
  );

export const actorHandle = (user: User) => ({
  id: user.collective.publicId,
  legacyId: user.collective.id,
  slug: user.collective.slug,
  name: user.collective.name,
  email: user.email,
  // Session auth avoids global sign-in rate counters and tokens in browser
  // navigation URLs. Only safe to return after commit.
  token: user.jwt({ scope: 'session' }, TOKEN_EXPIRATION_SESSION),
});

export const accountHandle = (account: Collective) => ({
  id: account.publicId,
  legacyId: account.id,
  slug: account.slug,
  name: account.name,
  type: account.type,
});

export const expenseHandle = (expense: Expense, account: Collective) => ({
  id: expense.publicId,
  legacyId: expense.id,
  description: expense.description,
  status: expense.status,
  url: `/${account.slug}/expenses/${expense.id}`,
});

/**
 * A signed-up user with a completed profile and no memberships. The profile
 * slug derives from the name, so always use the returned handle.
 */
export async function createActor(ctx: FixtureContext, label: string): Promise<User> {
  ctx.checkConnection();
  return User.createUserWithCollective(
    {
      // Matches the local sign-in shortcut pattern for journeys that sign in through the UI.
      email: `testuser+${ctx.slug(label)}@opencollective.com`,
      name: ctx.slug(label),
      data: { requiresProfileCompletion: false },
    },
    ctx.transaction,
  );
}

/**
 * An active fiscal host owned by this request, set up for money management the way the product's
 * organization-creation mutation does it (unlike the unhosted payee profile `createOrganization` below arranges).
 * `label` distinguishes a second host of the same request; `useVendorPolicy` sets who may use the host's
 * vendors (left unset, the host has no policies and the product default applies).
 */
export async function createHost(
  ctx: FixtureContext,
  admin: User,
  {
    currency = 'USD',
    label = 'host',
    useVendorPolicy,
  }: { currency?: SupportedCurrency; label?: string; useVendorPolicy?: UseVendorPolicyValue } = {},
): Promise<Collective> {
  ctx.checkConnection();
  const { transaction } = ctx;
  const host = await Collective.create(
    {
      type: CollectiveType.ORGANIZATION,
      name: label === 'host' ? `Host ${ctx.tag}` : `Host ${ctx.tag} ${label}`,
      slug: ctx.slug(label),
      description: 'An independent Playwright fiscal host',
      currency,
      CreatedByUserId: admin.id,
      data: arrangedBy(ctx),
    },
    { transaction },
  );
  await host.activateMoneyManagement({ remoteUser: admin, silent: true, transaction });
  // `activateHosting` without its activity, which would email the admin even if this request rolls back.
  await host.update({ hasHosting: true }, { transaction });
  if (useVendorPolicy) {
    // What `setPolicies` stores, inside the request transaction.
    await host.update(
      { data: { ...host.data, policies: { [POLICIES.USE_VENDOR_POLICY]: useVendorPolicy } } },
      { transaction },
    );
  }
  await createAccountAdminMembers(host, [admin], { transaction });
  return host;
}

/**
 * A vendor of a host, as the product's vendor-creation mutation stores it: usable with every Account of the
 * host unless `usableWith` names some, and following the host's vendor policy unless `useVendorPolicy`
 * overrides it. `usableWith` must only hold the host or Accounts it hosts; the recipe checks that on its
 * inputs, where a mistake is answered as an invalid request. Records no activity.
 */
export async function createVendor(
  ctx: FixtureContext,
  label: string,
  {
    host,
    creator,
    name,
    usableWith = [],
    useVendorPolicy = null,
    payoutMethod = false,
  }: {
    host: Collective;
    creator: User;
    /** Pickers cut names off after about 35 characters: keep it shorter and unique to the request. */
    name: string;
    usableWith?: Collective[];
    useVendorPolicy?: UseVendorPolicyValue | null;
    payoutMethod?: boolean;
  },
): Promise<Collective> {
  ctx.checkConnection();
  const slug = ctx.slug(label);
  const vendor = await Collective.create(
    {
      type: CollectiveType.VENDOR,
      name,
      slug,
      currency: host.currency,
      isActive: false,
      ParentCollectiveId: host.id,
      isPrivate: host.isPrivate,
      CreatedByUserId: creator.id,
      data: {
        vendorInfo: {},
        canBeUsedWithAccountIds: [...new Set(usableWith.map(account => account.id))],
        useVendorPolicy,
        ...arrangedBy(ctx),
      },
    },
    { transaction: ctx.transaction },
  );
  if (payoutMethod) {
    await createPayoutMethod(ctx, { account: vendor, creator, name: 'Bank' });
  }
  return vendor;
}

/** An approved, active Collective under a host. `admins` may be empty for a Collective nobody in the journey manages. */
export async function createHostedCollective(
  ctx: FixtureContext,
  label: string,
  {
    host,
    creator,
    admins = [],
    country,
    settings = {},
  }: { host: Collective; creator: User; admins?: User[]; country?: string; settings?: AccountSettings },
): Promise<Collective> {
  ctx.checkConnection();
  const { transaction } = ctx;
  const slug = ctx.slug(label);
  const account = await Collective.create(
    {
      type: CollectiveType.COLLECTIVE,
      // The slug is part of the name so journeys can find and assert the Account in pickers and summaries.
      name: `${slug} Collective`,
      slug,
      description: 'An independent Playwright hosted Collective',
      currency: host.currency,
      HostCollectiveId: host.id,
      hostFeePercent: host.hostFeePercent,
      platformFeePercent: host.platformFeePercent,
      isActive: true,
      approvedAt: new Date(),
      CreatedByUserId: creator.id,
      settings,
      data: arrangedBy(ctx),
    },
    { transaction },
  );
  await addHostMember(ctx, account, creator);
  if (country) {
    await account.setLocation({ country }, transaction);
  }
  await createAccountAdminMembers(account, admins, { transaction });
  return account;
}

/**
 * An active Project under a hosted Collective, as `createProject` leaves it for
 * an active parent: same host, currency and fees, no admins of its own.
 */
export async function createProject(
  ctx: FixtureContext,
  label: string,
  { parent, creator }: { parent: Collective; creator: User },
): Promise<Collective> {
  ctx.checkConnection();
  const { transaction } = ctx;
  const slug = ctx.slug(label);
  const project = await Collective.create(
    {
      type: CollectiveType.PROJECT,
      name: `${slug} Project`,
      slug,
      description: 'An independent Playwright Project',
      currency: parent.currency,
      ParentCollectiveId: parent.id,
      HostCollectiveId: parent.HostCollectiveId,
      hostFeePercent: parent.hostFeePercent,
      platformFeePercent: parent.platformFeePercent,
      isActive: parent.isActive,
      approvedAt: parent.approvedAt,
      CreatedByUserId: creator.id,
      data: arrangedBy(ctx),
    },
    { transaction },
  );
  await addHostMember(ctx, project, creator);
  return project;
}

/** An unhosted Organization administered by an actor (a payee or invitee profile). */
export async function createOrganization(ctx: FixtureContext, label: string, admin: User): Promise<Collective> {
  ctx.checkConnection();
  const { transaction } = ctx;
  const slug = ctx.slug(label);
  const organization = await Collective.create(
    {
      type: CollectiveType.ORGANIZATION,
      name: `${slug} Organization`,
      slug,
      currency: 'USD',
      HostCollectiveId: null,
      isActive: false,
      CreatedByUserId: admin.id,
      data: arrangedBy(ctx),
    },
    { transaction },
  );
  await createAccountAdminMembers(organization, [admin], { transaction });
  return organization;
}

/** A saved "Other" payout method on an Account. */
export async function createPayoutMethod(
  ctx: FixtureContext,
  {
    account,
    creator,
    name,
    currency = 'USD',
  }: { account: Collective; creator: User; name: string; currency?: SupportedCurrency },
): Promise<PayoutMethod> {
  ctx.checkConnection();
  return PayoutMethod.create(
    {
      type: PayoutMethodTypes.OTHER,
      name,
      data: { content: `Payout details for ${name}`, currency },
      currency,
      isSaved: true,
      CollectiveId: account.id,
      CreatedByUserId: creator.id,
    },
    { transaction: ctx.transaction },
  );
}

type ItemInput = { description: string; amount: number };

/**
 * A real file in the uploads bucket and the `UploadedFiles` row that makes the product accept and serve it.
 * Storage is outside the request transaction, so the object key derives from the request identity: a
 * repeated request overwrites its own object, and a rolled-back one leaves a file nothing refers to under
 * a `pw-` prefix that names it.
 */
async function createStoredFile(
  ctx: FixtureContext,
  {
    kind,
    folder,
    fileName,
    contentType,
    body,
  }: {
    kind: FileKind;
    folder: string;
    fileName: string;
    contentType: (typeof SUPPORTED_FILE_TYPES)[number];
    body: Buffer;
  },
  creator: User,
): Promise<UploadedFile> {
  ctx.checkConnection();
  if (!checkS3Configured()) {
    throw new Error('Stored files need the file storage the browser stack is launched with.');
  }
  const { url } = await uploadToS3({
    Bucket: config.aws.s3.bucket,
    Key: `${folder}/${ctx.slug('fixture')}/${fileName}`,
    Body: body,
    ACL: 'public-read',
    ContentLength: body.length,
    ContentType: contentType,
    Metadata: { CreatedByUserId: `${creator.id}`, FileKind: kind },
  });
  return UploadedFile.create(
    {
      kind,
      fileName,
      fileSize: body.length,
      fileType: contentType,
      url,
      data: { recordedFrom: 'e2e-fixture' },
      CreatedByUserId: creator.id,
    },
    { transaction: ctx.transaction },
  );
}

/** The receipt of one reimbursement item: a small real image. */
async function createStoredReceipt(ctx: FixtureContext, name: string, creator: User): Promise<UploadedFile> {
  const image = await sharp({ create: { width: 15, height: 15, channels: 3, background: '#297eff' } })
    .png()
    .toBuffer();
  return createStoredFile(
    ctx,
    { kind: 'EXPENSE_ITEM', folder: 'expense-item', fileName: `${name}.png`, contentType: 'image/png', body: image },
    creator,
  );
}

/** A one-page PDF 1.4 document showing `text` in Helvetica, with a valid cross-reference table. */
function onePagePdf(text: string): Buffer {
  const escaped = text.replace(/[\\()]/g, char => `\\${char}`);
  const content = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf, 'latin1');
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Attaches a stored PDF showing `text` to `expense`, as after its submitter uploaded it with the form. */
export async function attachStoredPdf(
  ctx: FixtureContext,
  { expense, submitter, name, text }: { expense: Expense; submitter: User; name: string; text: string },
): Promise<void> {
  const file = await createStoredFile(
    ctx,
    {
      kind: 'EXPENSE_ATTACHED_FILE',
      folder: 'expense-attached-file',
      fileName: name,
      contentType: 'application/pdf',
      body: onePagePdf(text),
    },
    submitter,
  );
  // The attachment holds the storage address, as after a real upload.
  await ExpenseAttachedFile.create(
    { ExpenseId: expense.id, CreatedByUserId: submitter.id, url: file.getDataValue('url') },
    { transaction: ctx.transaction },
  );
}

/**
 * An already submitted (pending) expense: prior history, never the submission a journey is testing.
 * An invoice unless `type` says otherwise; every item of a reimbursement carries a stored receipt.
 */
export async function createSubmittedExpense(
  ctx: FixtureContext,
  {
    account,
    submitter,
    payoutMethod,
    description,
    items,
    type = expenseType.INVOICE,
  }: {
    account: Collective;
    submitter: User;
    payoutMethod: PayoutMethod;
    description: string;
    items: ItemInput[];
    type?: expenseType.INVOICE | expenseType.RECEIPT;
  },
): Promise<Expense> {
  ctx.checkConnection();
  const { transaction } = ctx;
  const incurredAt = new Date();
  const expense = await Expense.create(
    {
      type,
      status: expenseStatus.PENDING,
      description,
      tags: ['engineering'],
      currency: account.currency,
      amount: items.reduce((total, item) => total + item.amount, 0),
      incurredAt,
      CollectiveId: account.id,
      FromCollectiveId: submitter.CollectiveId,
      UserId: submitter.id,
      lastEditedById: submitter.id,
      PayoutMethodId: payoutMethod.id,
      legacyPayoutMethod: Expense.getLegacyPayoutMethodTypeFromPayoutMethod(payoutMethod),
      data: { taxes: [] },
    },
    { transaction },
  );
  for (const [order, item] of items.entries()) {
    const receipt = type === expenseType.RECEIPT && (await createStoredReceipt(ctx, `receipt-${order}`, submitter));
    await ExpenseItem.create(
      {
        ...item,
        order,
        currency: expense.currency,
        expenseCurrencyFxRate: 1,
        incurredAt,
        ExpenseId: expense.id,
        CreatedByUserId: submitter.id,
        // The item holds the storage address, as after a real upload; reading `url` would give the protected link.
        ...(receipt && { url: receipt.getDataValue('url') }),
      },
      { transaction },
    );
  }
  return expense;
}

/**
 * A draft an inviter addressed to an existing payee Account, in the state
 * `draftExpenseAndInviteUser` leaves behind, minus the invitation email.
 * Completing the draft is the journey's behavior.
 */
export async function createInvitedDraftExpense(
  ctx: FixtureContext,
  {
    account,
    inviter,
    payee,
    description,
    currency,
    items,
  }: {
    account: Collective;
    inviter: User;
    payee: Collective;
    description: string;
    currency: SupportedCurrency;
    items: ItemInput[];
  },
): Promise<{ expense: Expense; draftKey: string }> {
  ctx.checkConnection();
  // The product uses this constant key in E2E environments; recipes only exist there.
  const draftKey = 'draft-key';
  const expense = await Expense.create(
    {
      type: expenseType.INVOICE,
      status: expenseStatus.DRAFT,
      description,
      currency,
      amount: items.reduce((total, item) => total + item.amount, 0),
      incurredAt: new Date(),
      CollectiveId: account.id,
      FromCollectiveId: inviter.CollectiveId,
      UserId: inviter.id,
      lastEditedById: inviter.id,
      data: {
        items: items.map((item, order) => ({
          ...item,
          order,
          currency,
          expenseCurrencyFxRate: 1,
          expenseCurrencyFxRateSource: null,
        })),
        attachedFiles: null,
        invoiceFile: null,
        payee: payee.minimal,
        invitedByCollectiveId: inviter.CollectiveId,
        draftKey,
        notify: false,
      },
    },
    { transaction: ctx.transaction },
  );
  return { expense, draftKey };
}
