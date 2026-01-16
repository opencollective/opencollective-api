import fs from 'fs';

import { idEncode } from '../graphql/v2/identifiers';

import handlebars from './handlebars';

/*
 * Loads all the email templates
 */

const templates = {};

export const templateNames = [
  'order.canceled.archived.collective',
  'github.signup',
  'collective.apply',
  'collective.apply.for.host',
  'collective.approved',
  'collective.approved.opensource',
  'collective.approved.the-social-change-nest',
  'collective.rejected',
  'collective.comment.created',
  'collective.conversation.created',
  'collective.created',
  'collective.contact',
  'collective.frozen',
  'collective.unfrozen',
  'collective.unhosted',
  'collective.expense.approved',
  'collective.expense.approved.for.host',
  'collective.expense.created',
  'collective.expense.processing',
  'collective.expense.error',
  'collective.expense.error.for.host',
  'collective.expense.paid',
  'collective.expense.paid.for.host',
  'collective.expense.invite.drafted',
  'collective.expense.missing.receipt',
  'collective.expense.recurring.drafted',
  'collective.expense.rejected',
  'collective.expense.incomplete',
  'collective.expense.updated',
  'collective.expense.draft.updated.to.invitee',
  'collective.expense.reApprovalRequested',
  'collective.member.created',
  'collective.monthlyreport',
  'collective.newmember',
  'collective.update.published',
  'collective.virtualcard.added',
  'collective.virtualcard.missing.receipts',
  'collective.virtualcard.suspended',
  'collective.virtualcard.suspendedDueToInactivity',
  'collective.virtualcard.deleted',
  'collective.virtualcard.request.approved',
  'collective.virtualcard.request.rejected',
  'event.reminder.1d',
  'event.reminder.7d',
  'expense-accounting-category-educational',
  'host.application.contact',
  'host.application.comment.created',
  'member.invitation',
  'oauth.application.authorized',
  'onboarding.day2',
  'onboarding.day2.opensource',
  'onboarding.day2.organization',
  'onboarding.day3',
  'onboarding.day3.opensource',
  'onboarding.noExpenses',
  'onboarding.noExpenses.opensource',
  'onboarding.noUpdates',
  'onboarding.day7',
  'onboarding.day35.inactive',
  'organization.collective.created',
  'organization.newmember',
  'payment.failed',
  'payment.creditcard.confirmation',
  'payment.creditcard.expiring',
  'order.pending',
  'order.pending.created',
  'order.pending.received',
  'order.pending.crypto',
  'order.new.pendingFinancialContribution',
  'order.reminder.pendingFinancialContribution',
  'order.processing',
  'order.payment.failed',
  'platform.billing.new.expense',
  'platform.billing.overdue.reminder',
  'platform.billing.additional.charges.notification',
  'platform.billing.payment.confirmation',
  'report.platform',
  'report.platform.weekly',
  'subscription.canceled',
  'subscription.paused',
  'subscription.ready.to.be.resumed',
  'taxform.request',
  'taxform.invalidated',
  'taxform.received',
  'ticket.confirmed',
  'order.processed',
  'order.processed.fr',
  'order.processed.opensource',
  'user.card.claimed',
  'user.card.invited',
  'user.changeEmail',
  'user.monthlyreport',
  'user.new.token',
  'user.resetPassword',
  'user.yearlyreport',
  'user.otp.requested',
  'activated.moneyManagement',
  'deactivated.moneyManagement',
  'activated.hosting',
  'deactivated.hosting',
  'contribution.rejected',
  'virtualcard.charge.declined',
  'virtualcard.requested',
  'conversation.comment.created',
  'update.comment.created',
  'expense.comment.created',
  'virtualcard.purchase',
  'connected_account.removed',
  'platform.subscription.updated',
] as const;

export type EmailTemplates = (typeof templateNames)[number];

const templatesPath = `${__dirname}/../../templates`;

// Register partials
const header = fs.readFileSync(`${templatesPath}/partials/header.hbs`, 'utf8');
const greeting = fs.readFileSync(`${templatesPath}/partials/greeting.hbs`, 'utf8');
const footer = fs.readFileSync(`${templatesPath}/partials/footer.hbs`, 'utf8');
const toplogo = fs.readFileSync(`${templatesPath}/partials/toplogo.hbs`, 'utf8');
const opensourceSignature = fs.readFileSync(`${templatesPath}/partials/opensource-signature.hbs`, 'utf8');
const eventsnippet = fs.readFileSync(`${templatesPath}/partials/eventsnippet.hbs`, 'utf8');
const expenseItems = fs.readFileSync(`${templatesPath}/partials/expense-items.hbs`, 'utf8');
const eventdata = fs.readFileSync(`${templatesPath}/partials/eventdata.hbs`, 'utf8');
const collectivecard = fs.readFileSync(`${templatesPath}/partials/collectivecard.hbs`, 'utf8');
const linkCollective = fs.readFileSync(`${templatesPath}/partials/link-collective.hbs`, 'utf8');
const chargeDateNotice = fs.readFileSync(`${templatesPath}/partials/charge_date_notice.hbs`, 'utf8');
const erratumBox = fs.readFileSync(`${templatesPath}/partials/erratum-box.hbs`, 'utf8');
const mthReportFooter = fs.readFileSync(`${templatesPath}/partials/monthlyreport.footer.hbs`, 'utf8');
const mthReportSubscription = fs.readFileSync(`${templatesPath}/partials/monthlyreport.subscription.hbs`, 'utf8');
const planDetails = fs.readFileSync(`${templatesPath}/partials/plan-details.hbs`, 'utf8');
const subscriptionDetails = fs.readFileSync(`${templatesPath}/partials/subscription-details.hbs`, 'utf8');

handlebars.registerPartial('header', header);
handlebars.registerPartial('greeting', greeting);
handlebars.registerPartial('footer', footer);
handlebars.registerPartial('toplogo', toplogo);
handlebars.registerPartial('opensourceSignature', opensourceSignature);
handlebars.registerPartial('collectivecard', collectivecard);
handlebars.registerPartial('linkCollective', linkCollective);
handlebars.registerPartial('eventsnippet', eventsnippet);
handlebars.registerPartial('expenseItems', expenseItems);
handlebars.registerPartial('eventdata', eventdata);
handlebars.registerPartial('charge_date_notice', chargeDateNotice);
handlebars.registerPartial('erratum-box', erratumBox);
handlebars.registerPartial('mr-footer', mthReportFooter);
handlebars.registerPartial('mr-subscription', mthReportSubscription);
handlebars.registerPartial('plan-details', planDetails);
handlebars.registerPartial('subscription-details', subscriptionDetails);
handlebars.registerHelper('idEncode', (id, type) => {
  return idEncode(id, type);
});

export const isValidTemplate = (template: string): template is EmailTemplates => {
  return Boolean(templates[template]);
};

export const recompileAllTemplates = () => {
  templateNames.forEach(template => {
    const source = fs.readFileSync(`${templatesPath}/emails/${template}.hbs`, 'utf8');
    templates[template] = handlebars.compile(source);
  });
};

recompileAllTemplates();

export default templates as Record<EmailTemplates, handlebars.TemplateDelegate>;
