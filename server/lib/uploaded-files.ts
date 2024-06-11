import { FileKind } from '../constants/file-kind';
import models from '../models';

/**
 * Defines all the other places where files can be used. In the future, we might want to
 * replace this by real DB associations.
 */
export const FileFieldsDefinition: Record<
  Exclude<FileKind, 'AGREEMENT_ATTACHMENT' | 'TRANSACTIONS_IMPORT'>,
  {
    model;
    field: string;
    fieldType: 'url' | 'richText';
    UserIdField?: string;
  }
> = {
  // Simple fields
  ACCOUNT_AVATAR: {
    model: models.Collective,
    field: 'image',
    fieldType: 'url',
  },
  ACCOUNT_BANNER: {
    model: models.Collective,
    field: 'backgroundImage',
    fieldType: 'url',
  },
  EXPENSE_ITEM: {
    model: models.ExpenseItem,
    field: 'url',
    UserIdField: 'CreatedByUserId',
    fieldType: 'url',
  },
  EXPENSE_ATTACHED_FILE: {
    model: models.ExpenseAttachedFile,
    field: 'url',
    UserIdField: 'CreatedByUserId',
    fieldType: 'url',
  },
  // Rich text fields
  ACCOUNT_LONG_DESCRIPTION: {
    model: models.Collective,
    field: 'longDescription',
    fieldType: 'richText',
  },
  UPDATE: {
    model: models.Update,
    field: 'html',
    fieldType: 'richText',
    UserIdField: 'LastEditedByUserId',
  },
  COMMENT: {
    model: models.Comment,
    field: 'html',
    fieldType: 'richText',
    UserIdField: 'CreatedByUserId',
  },
  TIER_LONG_DESCRIPTION: {
    model: models.Tier,
    field: 'longDescription',
    fieldType: 'richText',
  },
  ACCOUNT_CUSTOM_EMAIL: {
    model: models.Collective,
    field: 'settings.customEmailMessage',
    fieldType: 'richText',
  },
};
