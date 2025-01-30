import { expect } from 'chai';

import { mergeDataDeep, moveSection, removeSection } from '../../../migrations/lib/helpers';

describe('migrations/lib/helpers', () => {
  describe('moveSection', () => {
    it('Returns original settings if not supported by the collective', () => {
      const settings = {};
      expect(moveSection(settings, 'test', 'test')).to.eq(settings);
    });

    it('Returns original settings if no change', () => {
      const settings = { collectivePage: { sections: [{ type: 'CATEGORY', name: 'BUDGET', sections: [] }] } };
      expect(moveSection(settings, 'test', 'test')).to.eq(settings);
    });

    it('Moves the section in the right category', () => {
      const settings = {
        collectivePage: {
          sections: [
            { type: 'CATEGORY', name: 'BUDGET', sections: [{ type: 'SECTION', name: 'test' }] },
            { type: 'SECTION', name: 'newSection' },
          ],
        },
      };

      expect(moveSection(settings, 'newSection', 'BUDGET')).to.deep.eq({
        collectivePage: {
          sections: [
            {
              type: 'CATEGORY',
              name: 'BUDGET',
              sections: [
                { type: 'SECTION', name: 'test' },
                { type: 'SECTION', name: 'newSection' },
              ],
            },
          ],
        },
      });
    });

    it('Creates the category if it does not exist', () => {
      const settings = {
        collectivePage: {
          sections: [{ type: 'SECTION', name: 'newSection' }],
        },
      };

      expect(moveSection(settings, 'newSection', 'BUDGET')).to.deep.eq({
        collectivePage: {
          sections: [
            {
              type: 'CATEGORY',
              name: 'BUDGET',
              sections: [{ type: 'SECTION', name: 'newSection' }],
            },
          ],
        },
      });
    });
  });

  describe('removeSection', () => {
    it('Returns original settings if not supported by the collective', () => {
      const settings = {};
      expect(removeSection(settings, 'test')).to.eq(settings);
    });

    it('Returns original settings if no change', () => {
      const settings = { collectivePage: { sections: [{ type: 'CATEGORY', name: 'BUDGET', sections: [] }] } };
      expect(removeSection(settings, 'test')).to.eq(settings);
    });

    it('Returns original settings if no change in nested section', () => {
      const settings = {
        collectivePage: {
          sections: [
            {
              type: 'CATEGORY',
              name: 'BUDGET',
              sections: [{ type: 'SECTION', name: 'test' }],
            },
          ],
        },
      };
      expect(removeSection(settings, 'test')).to.eq(settings);
    });

    it('Removes the section', () => {
      const settings = {
        collectivePage: {
          sections: [
            { type: 'CATEGORY', name: 'BUDGET', sections: [{ type: 'SECTION', name: 'test' }] },
            { type: 'SECTION', name: 'newSection' },
          ],
        },
      };

      expect(removeSection(settings, 'newSection')).to.deep.eq({
        collectivePage: {
          sections: [{ type: 'CATEGORY', name: 'BUDGET', sections: [{ type: 'SECTION', name: 'test' }] }],
        },
      });
    });

    it('Removes the nested section', () => {
      const settings = {
        collectivePage: {
          sections: [
            { type: 'CATEGORY', name: 'BUDGET', sections: [{ type: 'SECTION', name: 'test' }] },
            { type: 'SECTION', name: 'newSection' },
          ],
        },
      };

      expect(removeSection(settings, 'test', 'BUDGET')).to.deep.eq({
        collectivePage: {
          sections: [
            { type: 'CATEGORY', name: 'BUDGET', sections: [] },
            { type: 'SECTION', name: 'newSection' },
          ],
        },
      });
    });
  });

  describe('mergeDataDeep', () => {
    it('merges data deep', () => {
      expect(
        mergeDataDeep({
          data: {
            data: {
              data: {
                data: {
                  data: {
                    data: {
                      data: {
                        data: {
                          data: {
                            data: {
                              policies: {
                                EXPENSE_POLICIES: {
                                  titlePolicy: '',
                                  invoicePolicy: '',
                                  receiptPolicy: '',
                                },
                                EXPENSE_CATEGORIZATION: {
                                  requiredForCollectiveAdmins: true,
                                  requiredForExpenseSubmitters: true,
                                },
                                EXPENSE_PUBLIC_VENDORS: false,
                                REQUIRE_2FA_FOR_ADMINS: true,
                                COLLECTIVE_MINIMUM_ADMINS: {
                                  freeze: false,
                                  applies: 'NEW_COLLECTIVES',
                                  numberOfAdmins: 0,
                                },
                                COLLECTIVE_ADMINS_CAN_REFUND: true,
                                EXPENSE_AUTHOR_CANNOT_APPROVE: {
                                  enabled: false,
                                  amountInCents: 0,
                                  appliesToHostedCollectives: false,
                                  appliesToSingleAdminCollectives: false,
                                },
                              },
                            },
                            policies: {
                              EXPENSE_POLICIES: {
                                titlePolicy: '',
                                invoicePolicy: '',
                                receiptPolicy: '',
                              },
                            },
                          },
                          policies: {
                            EXPENSE_POLICIES: {
                              titlePolicy: '',
                              invoicePolicy: '',
                              receiptPolicy: '',
                            },
                            REQUIRE_2FA_FOR_ADMINS: true,
                          },
                        },
                        policies: {
                          EXPENSE_POLICIES: {
                            titlePolicy: '',
                            invoicePolicy: '',
                            receiptPolicy: '',
                          },
                        },
                      },
                      policies: {
                        EXPENSE_POLICIES: {
                          titlePolicy: '',
                          invoicePolicy: '',
                          receiptPolicy: '',
                        },
                      },
                    },
                    policies: {
                      EXPENSE_POLICIES: {
                        titlePolicy: '',
                        invoicePolicy: '',
                        receiptPolicy: '',
                      },
                    },
                  },
                  policies: {
                    EXPENSE_POLICIES: {
                      titlePolicy: '',
                      invoicePolicy: '',
                      receiptPolicy: '',
                    },
                  },
                },
                policies: {
                  EXPENSE_POLICIES: {
                    titlePolicy: '',
                    invoicePolicy: '',
                    receiptPolicy: '',
                  },
                },
              },
              policies: {
                EXPENSE_POLICIES: {
                  titlePolicy: '',
                  invoicePolicy: '',
                  receiptPolicy: '',
                },
              },
            },
            policies: {
              EXPENSE_POLICIES: {
                titlePolicy: '',
                invoicePolicy: '',
                receiptPolicy: '',
              },
            },
          },
          isTrustedHost: true,
        }),
      ).to.deep.eq({
        isTrustedHost: true,
        policies: {
          EXPENSE_POLICIES: {
            titlePolicy: '',
            invoicePolicy: '',
            receiptPolicy: '',
          },
          EXPENSE_CATEGORIZATION: {
            requiredForCollectiveAdmins: true,
            requiredForExpenseSubmitters: true,
          },
          EXPENSE_PUBLIC_VENDORS: false,
          REQUIRE_2FA_FOR_ADMINS: true,
          COLLECTIVE_MINIMUM_ADMINS: {
            freeze: false,
            applies: 'NEW_COLLECTIVES',
            numberOfAdmins: 0,
          },
          COLLECTIVE_ADMINS_CAN_REFUND: true,
          EXPENSE_AUTHOR_CANNOT_APPROVE: {
            enabled: false,
            amountInCents: 0,
            appliesToHostedCollectives: false,
            appliesToSingleAdminCollectives: false,
          },
        },
      });
    });

    it('works ok with simple cases', () => {
      expect(mergeDataDeep({ data: { key: 1 }, key: 2 })).to.deep.eq({ key: 2 });
      expect(mergeDataDeep({ data: { key: 1 } })).to.deep.eq({ key: 1 });
    });
  });
});
