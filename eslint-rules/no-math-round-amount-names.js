'use strict';

/**
 * Custom ESLint rule: opencollective-currency/no-math-round-amount-names
 *
 * Warns when Math.round is used on expressions that reference monetary-looking
 * identifiers (amount, fee, tax, tip, etc.). Math.round does not respect
 * zero-decimal currencies (e.g. JPY); use currency helpers instead.
 */

const MONETARY_SEGMENTS = new Set([
  'amount',
  'amounts',
  'tip',
  'tips',
  'fee',
  'fees',
  'tax',
  'taxes',
  'price',
  'prices',
  'cost',
  'costs',
  'total',
  'totals',
  'subtotal',
  'subtotals',
  'balance',
  'balances',
  'charge',
  'charges',
  'payout',
  'payouts',
  'refund',
  'refunds',
  'donation',
  'donations',
  'contribution',
  'contributions',
  'revenue',
  'revenues',
  'payment',
  'payments',
  'commission',
  'commissions',
  'dues',
  'installment',
  'installments',
  'withholding',
  'royalty',
  'royalties',
  'invoice',
  'invoices',
  'budget',
  'budgets',
  'ledger',
  'wallet',
  'wallets',
  'discount',
  'discounts',
  'surcharge',
  'surcharges',
  'penalty',
  'penalties',
  'interest',
  'principal',
  'credit',
  'credits',
  'debit',
  'debits',
  'gratuity',
  'income',
  'proceeds',
  'earnings',
  'salary',
  'salaries',
  'wage',
  'wages',
  'compensation',
  'reimbursement',
  'margin',
  'margins',
  'net',
  'gross',
  'profit',
  'profits',
  'loss',
  'losses',
]);

/** After "total", these trailing parts usually mean a count or size, not money. */
const AFTER_TOTAL_NON_MONETARY = new Set([
  'count',
  'counts',
  'index',
  'indices',
  'row',
  'rows',
  'page',
  'pages',
  'item',
  'items',
  'step',
  'steps',
  'length',
  'lengths',
  'size',
  'sizes',
  'weight',
  'weights',
  'duration',
  'seconds',
  'minutes',
  'hours',
  'days',
  'member',
  'members',
  'user',
  'users',
  'record',
  'records',
  'entry',
  'entries',
  'line',
  'lines',
  'column',
  'columns',
  'attempt',
  'attempts',
]);

function splitNameIntoParts(name) {
  if (!name || typeof name !== 'string') {
    return [];
  }
  const normalized = name.replace(/_/g, ' ');
  const spaced = normalized
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  if (!spaced) {
    return [];
  }
  return spaced.split(/\s+/).filter(Boolean);
}

function nameLooksMonetary(name) {
  const parts = splitNameIntoParts(name);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!MONETARY_SEGMENTS.has(p)) {
      continue;
    }
    if (p === 'total' && parts[i + 1] && AFTER_TOTAL_NON_MONETARY.has(parts[i + 1])) {
      continue;
    }
    if (p === 'net' && parts[i - 1] === 'sub') {
      continue;
    }
    return true;
  }
  return false;
}

function isMathRoundCall(node) {
  if (node.type !== 'CallExpression' || node.optional) {
    return false;
  }
  const callee = node.callee;
  if (
    callee.type === 'MemberExpression' &&
    !callee.optional &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'Math' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'round' &&
    !callee.computed
  ) {
    return true;
  }
  if (
    callee.type === 'OptionalMemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'Math' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'round' &&
    !callee.computed
  ) {
    return true;
  }
  return false;
}

function eachMonetaryNameInExpression(node, visitor) {
  const visit = n => {
    if (!n || typeof n !== 'object') {
      return;
    }

    switch (n.type) {
      case 'Identifier':
        if (nameLooksMonetary(n.name)) {
          visitor(n, n.name);
        }
        return;
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        if (!n.computed && n.property.type === 'Identifier' && nameLooksMonetary(n.property.name)) {
          visitor(n.property, n.property.name);
        } else if (
          n.computed &&
          n.property.type === 'Literal' &&
          typeof n.property.value === 'string' &&
          nameLooksMonetary(n.property.value)
        ) {
          visitor(n.property, n.property.value);
        }
        visit(n.object);
        return;
      }
      case 'ChainExpression':
        visit(n.expression);
        return;
      case 'TSNonNullExpression':
      case 'TSAsExpression':
      case 'TSTypeAssertion':
        visit(n.expression);
        return;
      case 'UnaryExpression':
        visit(n.argument);
        return;
      case 'BinaryExpression':
      case 'LogicalExpression':
        visit(n.left);
        visit(n.right);
        return;
      case 'ConditionalExpression':
        visit(n.test);
        visit(n.consequent);
        visit(n.alternate);
        return;
      case 'CallExpression':
      case 'OptionalCallExpression':
        visit(n.callee);
        for (const arg of n.arguments) {
          visit(arg);
        }
        return;
      case 'SequenceExpression':
        for (const expr of n.expressions) {
          visit(expr);
        }
        return;
      case 'ArrayExpression':
        for (const el of n.elements) {
          if (el) {
            visit(el);
          }
        }
        return;
      case 'ObjectExpression':
        for (const prop of n.properties) {
          if (prop.type === 'SpreadElement') {
            visit(prop.argument);
          } else if (prop.type === 'Property') {
            visit(prop.value);
          }
        }
        return;
      case 'AssignmentExpression':
        visit(n.right);
        return;
      case 'AwaitExpression':
        visit(n.argument);
        return;
      case 'TemplateLiteral':
        for (const e of n.expressions) {
          visit(e);
        }
        return;
      case 'TaggedTemplateExpression':
        visit(n.tag);
        visit(n.quasi);
        return;
      case 'NewExpression':
        visit(n.callee);
        for (const arg of n.arguments) {
          visit(arg);
        }
        return;
      case 'SpreadElement':
        visit(n.argument);
        return;
      default:
        return;
    }
  };

  visit(node);
}

// eslint-disable-next-line import/no-commonjs
module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Avoid Math.round on monetary-looking names; use roundCentsAmount from server/lib/currency (including zero-decimal currencies).',
    },
    schema: [],
    messages: {
      avoid:
        'Math.round is not reliable for money (e.g. zero-decimal currencies such as JPY). Use `roundCentsAmount` from `@opencollective-api/server/lib/currency.ts` instead of rounding `{{name}}` with Math.round.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isMathRoundCall(node)) {
          return;
        }
        const arg = node.arguments[0];
        if (!arg) {
          return;
        }

        let reported = false;
        eachMonetaryNameInExpression(arg, (_refNode, name) => {
          if (reported) {
            return;
          }
          reported = true;
          context.report({
            node,
            messageId: 'avoid',
            data: { name },
          });
        });
      },
    };
  },
};
