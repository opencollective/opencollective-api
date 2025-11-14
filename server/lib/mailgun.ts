import config from 'config';
import { Request } from 'express';
import assert from 'node:assert';
import fetch from 'node-fetch';
import { v4 as uuid } from 'uuid';

import { expenseStatus, expenseTypes } from '../constants';
import logger from '../lib/logger';
import { Collective, Expense, UploadedFile, User } from '../models';

type MailgunPostBody = {
  Autocrypt: string;
  'Content-Language': string;
  'Content-Type': string;
  Date: string;
  'Dkim-Signature': string;
  From: string;
  'Message-Id': string;
  'Mime-Version': '1.0';
  Organization: string;
  Received: string;
  'Return-Path': string;
  To: string;
  'User-Agent': string;
  'X-Envelope-From': string;
  'X-Gm-Gg': string;
  'X-Gm-Message-State': string;
  'X-Google-Dkim-Signature': string;
  'X-Google-Smtp-Source': string;
  'X-Mailgun-Incoming': 'Yes';
  'X-Received': string;
  attachments: string;
  'body-html': string;
  'body-plain': string;
  domain: string;
  from: string;
  'message-headers': string;
  'message-url': string;
  recipient: string;
  sender: string;
  signature: string;
  'stripped-html': string;
  'stripped-signature': string;
  'stripped-text': string;
  subject: string;
  timestamp: string;
  token: string;
};

type MailgunAttachment = {
  name: string;
  'content-type': string;
  size: number;
  url: string;
};

const processAttachment = async (attachment: MailgunAttachment, user: User): Promise<UploadedFile> => {
  const authenticatedUrl = new URL(attachment.url);
  authenticatedUrl.password = config.mailgun.apiKey;
  authenticatedUrl.username = 'api';
  // TODO: Add more validation that the attachments is stored in Mailgun
  const response = await fetch(authenticatedUrl.toString());

  if (!response.ok) {
    throw new Error(`Failed to fetch attachment: ${response.statusText}`);
  } else {
    const buffer = await response.buffer();
    const size = buffer.byteLength;
    const mimetype = response.headers.get('Content-Type') || attachment['content-type'] || 'unknown';
    const originalname = attachment.name;
    const file = {
      buffer,
      size,
      mimetype,
      originalname,
    };
    const uploadedFile = await UploadedFile.upload(file, 'EXPENSE_ITEM', user);
    return uploadedFile;
  }
};

/**
 * Create a draft expense from attachments sent through an email to 'collective-slug@domain.com'
 */
export async function draftExpenseFromEmail(req: Request) {
  const email: MailgunPostBody = req.body;
  const attachments: MailgunAttachment[] = JSON.parse(email.attachments);
  const userEmail = email.sender;
  const collectiveSlug = email.recipient.split('@')?.[0];

  // TODO: Add more validation that the email is coming from Mailgun

  if (attachments.length === 0) {
    logger.info(`No attachments found for email from ${userEmail}`);
    return;
  }
  const existingCreatedExpense = await Expense.findOne({ where: { data: { emailId: email['Message-Id'] } } });
  if (existingCreatedExpense) {
    logger.info(
      `Expense already created for email from ${userEmail} with Message-Id ${email['Message-Id']}, skipping creation.`,
    );
    return;
  }

  const collective = await Collective.findOne({ where: { slug: collectiveSlug } });
  assert(collective, `No collective found for slug ${collectiveSlug}`);
  const user = await User.findOne({ where: { email: userEmail } });
  assert(user, `No user found for email ${userEmail}`);
  const fromCollective = await user.getCollective();
  // TODO: Add policy to allow collective admins to restrict who can submit expenses by email

  const draftKey = process.env.OC_ENV === 'e2e' || process.env.OC_ENV === 'ci' ? 'draft-key' : uuid();

  const items = [];
  for (const attachment of attachments) {
    const uploadedFile = await processAttachment(attachment, user);
    // TODO: Use AI to parse amount and description
    items.push({
      id: uuid(),
      url: uploadedFile.url,
      amount: 1,
      __isNew: true,
      description: uploadedFile.fileName,
    });
  }

  // Create the expense
  const expense = await Expense.create({
    // TODO: Is there a simple way to decide if it's a receipt or an invoice?
    type: expenseTypes.RECEIPT,
    status: expenseStatus.DRAFT,
    CollectiveId: collective.id,
    FromCollectiveId: fromCollective.id,
    lastEditedById: user.id,
    UserId: user.id,
    currency: collective.currency,
    incurredAt: new Date(),
    description: email.subject || 'Expense submitted by email',
    amount: 1,
    data: {
      items,
      draftKey,
      notify: true,
      email,
      emailId: email['Message-Id'],
    },
  });
  logger.info(`Created draft expense #${expense.id} for email from ${userEmail}`);
}
