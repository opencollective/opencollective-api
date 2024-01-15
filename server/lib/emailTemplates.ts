import fs from 'fs';

import handlebars from './handlebars';

/*
 * Loads all the email templates
 */

const templates = {};

export const templateNames = [
  'order.canceled.archived.collective',
  'github.signup',
  'collective.apply',
  'collective.apply.foundation',
  'collective.apply.for.host',
  'collective.approved',
  'collective.approved.foundation',
  'collective.approved.the-social-change-nest',
  'collective.rejected',
  'collective.comment.created',
  'collective.conversation.created',
  'collective.created',
  'collective.contact',
  'collective.frozen',
  'collective.unfrozen',
  'collective.unhosted',
  'collective.created.opensource',
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
  'confirm-guest-account',
  'event.reminder.1d',
  'event.reminder.7d',
  'fund.created.foundation',
  'fund.approved.foundation',
  'host.application.contact',
  'host.report',
  'member.invitation',
  'oauth.application.authorized',
  'onboarding.day2',
  'onboarding.day2.foundation',
  'onboarding.day2.opensource',
  'onboarding.day2.organization',
  'onboarding.day3',
  'onboarding.day3.foundation',
  'onboarding.day3.opensource',
  'onboarding.noExpenses',
  'onboarding.noExpenses.opensource',
  'onboarding.noUpdates',
  'onboarding.day21.noTwitter',
  'onboarding.day7',
  'onboarding.day35.active',
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
  'report.platform',
  'report.platform.weekly',
  'subscription.canceled',
  'taxform.request',
  'ticket.confirmed',
  'ticket.confirmed.fearlesscitiesbrussels',
  'ticket.confirmed.open-2020',
  'order.confirmed',
  'order.confirmed.wwcode',
  'order.confirmed.fr',
  'order.confirmed.foundation',
  'order.confirmed.opensource',
  'user.card.claimed',
  'user.card.invited',
  'user.changeEmail',
  'user.monthlyreport',
  'user.new.token',
  'user.resetPassword',
  'user.yearlyreport',
  'activated.collective.as.host',
  'activated.collective.as.independent',
  'deactivated.collective.as.host',
  'contribution.rejected',
  'virtualcard.charge.declined',
  'virtualcard.requested',
  'conversation.comment.created',
  'update.comment.created',
  'expense.comment.created',
  'virtualcard.purchase',
] as const;

export type EmailTemplates = (typeof templateNames)[number];

const templatesPath = `${__dirname}/../../templates`;

// Register partials
const header = fs.readFileSync(`${templatesPath}/partials/header.hbs`, 'utf8');
const greeting = fs.readFileSync(`${templatesPath}/partials/greeting.hbs`, 'utf8');
const footer = fs.readFileSync(`${templatesPath}/partials/footer.hbs`, 'utf8');
const toplogo = fs.readFileSync(`${templatesPath}/partials/toplogo.hbs`, 'utf8');
const eventsnippet = fs.readFileSync(`${templatesPath}/partials/eventsnippet.hbs`, 'utf8');
const expenseItems = fs.readFileSync(`${templatesPath}/partials/expense-items.hbs`, 'utf8');
const eventdata = fs.readFileSync(`${templatesPath}/partials/eventdata.hbs`, 'utf8');
const collectivecard = fs.readFileSync(`${templatesPath}/partials/collectivecard.hbs`, 'utf8');
const linkCollective = fs.readFileSync(`${templatesPath}/partials/link-collective.hbs`, 'utf8');
const chargeDateNotice = fs.readFileSync(`${templatesPath}/partials/charge_date_notice.hbs`, 'utf8');
const mthReportFooter = fs.readFileSync(`${templatesPath}/partials/monthlyreport.footer.hbs`, 'utf8');
const mthReportSubscription = fs.readFileSync(`${templatesPath}/partials/monthlyreport.subscription.hbs`, 'utf8');

handlebars.registerPartial('header', header);
handlebars.registerPartial('greeting', greeting);
handlebars.registerPartial('footer', footer);
handlebars.registerPartial('toplogo', toplogo);
handlebars.registerPartial('collectivecard', collectivecard);
handlebars.registerPartial('linkCollective', linkCollective);
handlebars.registerPartial('eventsnippet', eventsnippet);
handlebars.registerPartial('expenseItems', expenseItems);
handlebars.registerPartial('eventdata', eventdata);
handlebars.registerPartial('charge_date_notice', chargeDateNotice);
handlebars.registerPartial('mr-footer', mthReportFooter);
handlebars.registerPartial('mr-subscription', mthReportSubscription);

templateNames.forEach(template => {
  const source = fs.readFileSync(`${templatesPath}/emails/${template}.hbs`, 'utf8');
  templates[template] = handlebars.compile(source);
});

export default templates as Record<EmailTemplates, handlebars.TemplateDelegate>;
