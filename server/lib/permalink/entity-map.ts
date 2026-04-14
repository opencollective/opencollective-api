import moment from 'moment';

export enum EntityShortIdPrefix {
  AccountingCategory = 'acat',
  AccountingCategoryRule = 'acrule',
  Activity = 'act',
  Agreement = 'agr',
  Application = 'app',
  Comment = 'cmt',
  Collective = 'acc',
  ConnectedAccount = 'ca',
  Conversation = 'conv',
  Expense = 'ex',
  ExpenseAttachedFile = 'eaf',
  ExpenseItem = 'ei',
  ExportRequest = 'er',
  HostApplication = 'ha',
  KYCVerification = 'kyc',
  LegalDocument = 'ld',
  ManualPaymentProvider = 'mpp',
  Member = 'mem',
  MemberInvitation = 'mi',
  Notification = 'not',
  OAuthAuthorizationCode = 'oac',
  Order = 'or',
  PayoutMethod = 'po',
  PaymentMethod = 'pm',
  PersonalToken = 'pt',
  RecurringExpense = 're',
  Tier = 'tier',
  Transaction = 'tx',
  TransactionsImport = 'ti',
  TransactionsImportRow = 'tir',
  Update = 'upd',
  UploadedFile = 'uf',
  User = 'u',
  UserToken = 'utok',
  UserTwoFactorMethod = 'u2f',
  VirtualCard = 'vc',
  VirtualCardRequest = 'vcr',
}

export type EntityPublicId<E extends EntityShortIdPrefix> = `${E}_${string}`;

export function isEntityPublicId<E extends EntityShortIdPrefix>(
  publicId: unknown | null | undefined,
  EntityShortIdPrefix: E,
): publicId is EntityPublicId<E> {
  return publicId && typeof publicId === 'string' && publicId.startsWith(`${EntityShortIdPrefix}_`);
}

export function isAnyEntityPublicId(
  publicId: unknown | null | undefined,
): publicId is EntityPublicId<EntityShortIdPrefix> {
  return (
    publicId &&
    typeof publicId === 'string' &&
    Object.values(EntityShortIdPrefix).some(prefix => publicId.startsWith(`${prefix}_`))
  );
}

export function isEntityMigratedToPublicId(entity: EntityShortIdPrefix, createdAt: Date) {
  if (process.env.NODE_ENV === 'test' || process.env.CI === 'true') {
    return false;
  }

  if (entity === EntityShortIdPrefix.Transaction) {
    return false;
  }

  return moment(createdAt).isAfter(moment('2026-04-03'));
}

export function getEntityShortIdPrefix(publicId: string): EntityShortIdPrefix | null {
  for (const prefix of Object.values(EntityShortIdPrefix)) {
    if (publicId.startsWith(`${prefix}_`)) {
      return prefix;
    }
  }

  return null;
}
