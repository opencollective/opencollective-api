export default {
  host1: {
    name: 'WWCode',
    hostFeePercent: 10,
    email: 'finance+wwcode@opencollective.com',
    description: 'engineer',
    longDescription: 'This is a long description with some *markdown* **style**',
    twitterHandle: 'wwcode',
    address: 'Paradize street\nSan Francisco CA 94100\nUSA',
    currency: 'USD',
    isHostAccount: true,
    settings: { apply: true },
  },
  user1: {
    name: 'Phil Mod',
    email: 'user1@opencollective.com',
    description: 'engineer',
    longDescription: 'This is a long description with some *markdown* **style**',
    twitterHandle: 'philmod',
    address: 'Paradize street\nSan Francisco CA 94100\nUSA',
  },

  user2: {
    name: 'Anish Bas',
    image: 'https://pbs.twimg.com/profile_images/3075727251/5c825534ad62223ae6a539f6a5076d3c_400x400.jpeg',
    description: 'small guy',
    email: 'user2@opencollective.com',
    twitterHandle: 'abas',
    company: 'Open Collective Inc.',
    website: 'http://abas.com',
  },

  user3: {
    name: 'Xavier Damman',
    email: 'user3@opencollective.com',
    address: 'Rue du paradis\n1000 Brussels\nBelgium',
  },

  user4: {
    name: 'Bo Ki',
    email: 'user4@opencollective.com',
  },

  user5: {
    name: 'Bo Ki',
    email: 'user5@opencollective.org',
  },

  user6: {
    name: 'internal user',
    email: 'internal_user@opencollective.com',
  },

  collective1: {
    name: "Scouts d'Arlon",
    mission: 'toujours prêt',
    description: 'Troupe Scoute Albert Schweitzer',
    currency: 'EUR',
    budget: 1000000,
    burnrate: 10000,
    twitterHandle: 'scouts',
    website: 'http://scouts.org.uk/home/',
    slug: 'scouts',
    hostFeePercent: 10,
    tags: ['open source', 'test'],
    isActive: true,
  },

  collective2: {
    name: 'WWCode Austin',
    slug: 'wwcode-austin',
    mission: 'more women in tech',
    website: 'http://womenwhocode.com',
    currency: 'EUR',
    budget: 1000000,
    burnrate: 1000,
    hostFeePercent: 0,
    tags: ['meetup', 'test'],
    isActive: true,
  },

  collective3: {
    name: 'Yeoman',
  },

  collective4: {
    name: 'Open source collective',
    slug: 'meetups',
    settings: {
      superCollectiveTag: 'meetup',
    },
  },

  collective5: {
    name: 'Brussels Together',
    slug: 'brusselstogether',
    settings: {
      superCollectiveTag: '#brusselstogether',
    },
  },

  relatedCollectives: [
    {
      name: 'Reinventing Brussels',
      slug: 'reinventingbrussels',
      description: 'connect all the initiatives that create a welcoming &amp; sustainable city with deep human values',
      image: 'https://opencollective-production.s3-us-west-1.amazonaws.com/1738fae0-9a20-11e6-8650-f92e594d5de8.png',
      currency: 'EUR',
      settings: {
        style: { hero: { cover: { background: 'rgb(36,189,213)' } } },
      },
      tags: ['#brusselstogether'],
      isActive: true,
    },
    {
      name: 'Refugees Got Talent',
      slug: 'refugeesgottalent',
      description: 'offer a space and artistic material to refugees artists, so they can practice their art again.',
      image: 'https://cl.ly/0Q3N193Z1e3u/BrusselsTogetherLogo.png',
      currency: 'EUR',
      tags: ['#brusselstogether'],
      isActive: true,
    },
    {
      name: 'Brussels Smart City',
      slug: 'brusselssmartcity',
      description: 'improve the life of Brussels Citizens by the use of technology',
      image: 'https://cl.ly/0Q3N193Z1e3u/BrusselsTogetherLogo.png',
      currency: 'EUR',
      tags: ['#brusselstogether'],
      backgroundImage: 'http://www.hiddendistrict.be/wp-content/uploads/2015/01/Brussels_view-1000x500.jpg',
      isActive: true,
    },
  ],

  paymentMethod1: {
    token: 'PA-1B0110758V169653C',
    service: 'paypal',
    type: 'adaptive',
    startDate: '2017-01-30T07:31:37.747Z',
    endDate: '2018-01-30T07:31:37.747Z',
    confirmedAt: '2017-01-30T07:31:37.747Z',
  },

  paymentMethod2: {
    token: 'tok_123456781234567812345678',
    service: 'stripe',
    type: 'creditcard',
    customerId: 'cus_123',
    confirmedAt: '2017-01-30T07:31:37.747Z',
    name: '4242',
    data: {
      brand: 'visa',
      country: 'US',
      funding: 'credit',
      expMonth: 1,
      expYear: 2022,
    },
  },

  validCreditCard: {
    service: 'stripe',
    name: '4242',
    token: 'tok_visa',
    data: {
      brand: 'VISA',
      funding: 'credit',
      expMonth: 1,
      expYear: 2022,
    },
  },

  activities1: {
    activities: [
      {
        type: 'user.created',
        UserId: 1,
        data: {
          user: {
            name: 'John Doe',
            email: 'john@doe.com',
            websiteUrl: 'opencollective.com',
          },
          fromCollective: { name: 'John Doe', twitterHandle: 'johndoe' },
        },
      },
      {
        type: 'user.created',
        UserId: 2,
        data: { user: { email: 'john@doe.com' } },
      },
      { type: 'user.created', UserId: 3, data: {} },
      { type: 'collective.created', UserId: 1, CollectiveId: 1, data: {} },
      { type: 'collective.updated', UserId: 1, CollectiveId: 1, data: {} },
      { type: 'collective.updated', UserId: 3, CollectiveId: 1, data: {} },
      { type: 'collective.updated', UserId: 1, CollectiveId: 1, data: {} },
      { type: 'collective.updated', UserId: 3, CollectiveId: 1, data: {} },
      { type: 'collective.updated', UserId: 1, CollectiveId: 1, data: {} },
      { type: 'collective.deleted', UserId: 3, CollectiveId: 1, data: {} },
      {
        type: 'collective.transaction.created',
        userId: 3,
        CollectiveId: 1,
        data: {
          user: {
            email: 'john@doe.com',
          },
          transaction: {
            type: 'CREDIT',
            amount: 1042,
            currency: 'USD',
          },
          fromCollective: {},
          collective: {
            name: 'Pub quiz',
            slug: 'pubquiz',
            publicUrl: 'https://opencollective.com/pubquiz',
          },
        },
      },
      {
        type: 'collective.transaction.created',
        userId: 3,
        CollectiveId: 1,
        data: {
          user: {
            email: 'john@doe.com',
          },
          transaction: {
            type: 'DEBIT',
            amount: -1298,
            currency: 'USD',
            description: 'pizza',
            ExpenseId: 42,
          },
          collective: {
            name: 'Pub quiz',
            slug: 'pubquiz',
            publicUrl: 'https://opencollective.com/pubquiz',
          },
        },
      },
      {
        type: 'collective.transaction.created',
        userId: 3,
        CollectiveId: 1,
        data: {
          user: {
            email: 'john@doe.com',
          },
          transaction: {
            type: 'DEBIT',
            amount: -1298,
            currency: 'USD',
            description: 'Refund of test contribution',
            isRefund: true,
          },
          collective: {
            name: 'Pub quiz',
            slug: 'pubquiz',
            publicUrl: 'https://opencollective.com/pubquiz',
          },
        },
      },
      {
        type: 'collective.expense.paid',
        userId: 3,
        CollectiveId: 1,
        data: {
          user: {
            email: 'john@doe.com',
          },
          transaction: {
            type: 'DEBIT',
            amount: -1298,
            currency: 'USD',
            description: 'pizza',
          },
          collective: {
            name: 'Pub quiz',
            slug: 'pubquiz',
            publicUrl: 'https://opencollective.com/pubquiz',
          },
          expense: {
            id: 42,
            amount: 1298,
            currency: 'USD',
          },
          preapprovalDetails: {
            maxTotalAmountOfAllPayments: 200,
            curPaymentsAmount: 50,
          },
        },
      },
      {
        type: 'webhook.stripe.received',
        data: {
          event: {
            type: 'invoice.payment_succeeded',
          },
        },
      },
      {
        type: 'subscription.confirmed',
        data: {
          user: {
            email: 'jussi@kuohujoki.fi',
          },
          transaction: {
            type: 'CREDIT',
            amount: 1234,
            currency: 'EUR',
          },
          collective: {
            name: 'Blah',
            slug: 'blah',
            publicUrl: 'https://opencollective.com/blah',
          },
        },
      },
      {
        type: 'subscription.confirmed',
        data: {
          user: {
            email: 'jussi@kuohujoki.fi',
          },
          fromCollective: {
            twitterHandle: 'xdamman',
          },
          order: {
            totalAmount: 1234,
            currency: 'EUR',
          },
          subscription: {
            interval: 'month',
          },
          collective: {
            name: 'Yeoman',
            slug: 'yeoman',
            twitterHandle: 'yeoman',
            publicUrl: 'https://opencollective.com/yeoman',
          },
        },
      },
      {
        type: 'subscription.canceled',
        data: {
          user: {
            email: 'jussi@kuohujoki.fi',
          },
          fromCollective: {
            twitterHandle: 'xdamman',
          },
          order: {
            totalAmount: 1234,
            currency: 'EUR',
          },
          subscription: {
            interval: 'month',
            id: 4,
          },
          collective: {
            name: 'Yeoman',
            slug: 'yeoman',
            twitterHandle: 'yeoman',
            publicUrl: 'https://opencollective.com/yeoman',
          },
        },
      },
      {
        type: 'collective.created',
        data: {
          user: {
            email: 'jussi@kuohujoki.fi',
          },
          collective: {
            name: 'Blah',
            slug: 'blah',
            publicUrl: 'https://opencollective.com/blah',
          },
        },
      },
      {
        type: 'collective.expense.created',
        data: {
          user: {
            image: 'http://image.githubusercontent.com/asood123',
            id: 2,
          },
          collective: {
            name: 'Blah',
            publicUrl: 'blah.com',
            slug: 'blah',
          },
          expense: {
            id: 42,
            amount: 1234,
            currency: 'EUR',
            description: 'for pizza',
            payoutMethod: {
              id: 42,
              type: 'PAYPAL',
              data: { email: 'support@opencollective.com' },
            },
          },
        },
      },
      {
        type: 'collective.expense.rejected',
        data: {
          user: {
            id: 2,
          },
          fromCollective: {
            image: 'http://image.githubusercontent.com/asood123',
          },
          collective: {
            name: 'Blah',
            publicUrl: 'blah.com',
            slug: 'blah',
          },
          expense: {
            amount: 1234,
            currency: 'EUR',
            description: 'for pizza',
            lastEditedById: 2,
            id: 42,
          },
        },
      },
      {
        type: 'collective.expense.approved',
        data: {
          user: {
            id: 2,
          },
          fromCollective: {
            image: 'http://image.githubusercontent.com/asood123',
          },
          collective: {
            slug: 'blah',
            name: 'Blah',
            publicUrl: 'blah.com',
          },
          expense: {
            amount: 1234,
            currency: 'EUR',
            description: 'for pizza',
            lastEditedById: 2,
            id: 42,
          },
        },
      },
    ],
  },

  orders: [
    {
      description: 'Donation to that great project',
      amount: 100,
      currency: 'USD',
      createdAt: '2015-05-29T07:00:00.000Z',
    },
    {
      description: 'Donation to that other great project',
      amount: 999,
      currency: 'USD',
      createdAt: '2015-05-29T07:00:00.000Z',
    },
    {
      description: 'Donation to that amazing project',
      amount: 12000,
      currency: 'USD',
      createdAt: '2016-09-29T07:00:00.000Z',
    },
  ],

  transactions1: {
    transactions: [
      {
        description: 'Homepage design',
        tags: ['consultancy'],
        amount: -20000,
        type: 'DEBIT',
        amountInHostCurrency: -20000,
        currency: 'USD',
        hostCurrency: 'USD',
        createdAt: '2015-01-23T08:00:00.000Z',
      },
      // 1
      {
        description: 'Flight SFO-BRU',
        amount: -91859,
        type: 'DEBIT',
        currency: 'USD',
        createdAt: '2015-02-22T08:00:00.000Z',
      },
      // 2
      {
        description: 'Byword',
        amount: -1199,
        type: 'DEBIT',
        currency: 'USD',
        createdAt: '2015-03-04T08:00:00.000Z',
      },
      // 3
      {
        description: 'Tipbox.is domain + dedicated server',
        amount: -58861,
        type: 'DEBIT',
        currency: 'USD',
        createdAt: '2015-04-06T07:00:00.000Z',
      },
      // 4
      {
        description: 'Working lunch with @mdp',
        tags: ['food'],
        amount: -3600,
        type: 'DEBIT',
        currency: 'USD',
        createdAt: '2015-04-07T07:00:00.000Z',
      },
      // 5
      {
        description: 'Homepage design end',
        amount: -30000,
        type: 'DEBIT',
        currency: 'USD',
        createdAt: '2015-04-28T07:00:00.000Z',
      },
      // 6
      {
        description: 'Homepage frontend code',
        amount: -30000,
        type: 'DEBIT',
        currency: 'USD',
        createdAt: '2015-04-29T07:00:00.000Z',
      },
      // 7
      {
        description: 'Donation to that great project',
        amount: 10000,
        type: 'CREDIT',
        currency: 'USD',
        createdAt: '2015-05-29T07:00:00.000Z',
        PaymentMethodId: 1,
      },
      // 8
      {
        description: 'Donation to that great project',
        amount: 5000,
        netAmountInCollectiveCurrency: 4500,
        type: 'CREDIT',
        currency: 'USD',
        createdAt: '2018-05-29T07:00:00.000Z',
      },
    ],
  },

  emailData: {
    transaction: {
      id: 1,
      type: 'CREDIT',
      description: "Donation to Scouts d'Arlon",
      amount: 10.99,
      vat: null,
      currency: 'USD',
      tags: ['Donation'],
      status: null,
      link: null,
      createdAt: '2016-01-30T07:31:37.965Z',
      UserId: 1,
      CollectiveId: 1,
    },

    user: {
      id: 1,
      name: 'Phil Mod',
      email: 'user1@opencollective.com',
      image: null,
      twitterHandle: 'philmod',
      website: 'http://startupmanifesto.be',
      description: 'engineer',
      createdAt: '2016-01-30T07:31:37.747Z',
      updatedAt: '2016-01-30T07:31:37.889Z',
    },

    collective: {
      id: 1,
      name: "Scouts d'Arlon",
      mission: 'toujours prêt',
      description: 'Troupe Scoute Albert Schweitzer',
      longDescription: null,
      budget: 100000,
      burnrate: 1000,
      currency: 'USD',
      image: 'http://photos4.meetupstatic.com/photos/event/9/a/f/a/highres_18399674.jpeg',
      backgroundImage: null,
      createdAt: '2016-01-30T07:31:37.802Z',
      updatedAt: '2016-01-30T07:31:37.802Z',
      slug: 'WWCodeAtl',
      website: 'http://scouts.org.uk/home/',
      twitterHandle: 'scouts',
    },
  },
  subscription1: {
    amount: 2000,
    currency: 'EUR',
    interval: 'month',
    isActive: true,
    stripeSubscriptionId: 'sub_tokentest',
    nextChargeDate: '2018-02-01T07:31:37.747Z',
    nextPeriodStart: '2018-02-01T07:31:37.747Z',
    chargeRetryCount: 0,
  },
  expense1: {
    description: 'Expense 1: Lunch with Jenn',
    privateMessage: 'Some very long and super interesting extra notes for the whole world to see',
    category: 'Engineering',
    amount: 12000,
    currency: 'EUR',
    incurredAt: '2016-03-06 UTC+0300',
    legacyPayoutMethod: 'paypal',
    attachment: 'https://opencollective-production.s3-us-west-1.amazonaws.com/d6618050-82be-11e6-a262-73c13d37e1af.JPG',
  },
  expense2: {
    description: 'tshirts',
    privateMessage: 'longgggg note',
    category: 'Engineering',
    amount: 3737,
    currency: 'USD',
    incurredAt: '2016-03-09 UTC+0300',
    legacyPayoutMethod: 'manual',
  },
  expense3: {
    description: 'Expense 3: Lunch with Jenn',
    privateMessage: 'Some very long and super interesting extra notes for the whole world to see',
    category: 'Engineering',
    amount: 12000,
    currency: 'USD',
    incurredAt: '2016-03-06 UTC+0300',
    legacyPayoutMethod: 'paypal',
    attachment: 'https://opencollective-production.s3-us-west-1.amazonaws.com/d6618050-82be-11e6-a262-73c13d37e1af.JPG',
  },

  event1: {
    type: 'EVENT',
    name: 'January meetup',
    isActive: true,
    slug: 'jan-meetup',
    description: 'January monthly meetup',
    startsAt: '2017-01-06 UTC+0300',
    timezone: 'America/New_York',
    endsAt: '2017-01-07 UTC+300',
    locationName: 'Balanced NYC',
    address: '547 Broadway, NY 10012',
    backgroundImage: 'http://opencollective.com/backgroundimage.png',
    geoLocationLatLong: { type: 'Point', coordinates: [39.807222, -76.984722] },
  },

  event2: {
    type: 'EVENT',
    name: 'Feb meetup',
    slug: 'feb-meetup',
    description: 'February monthly meetup',
    startsAt: '2017-02-06 UTC+0300',
    endsAt: '2017-02-07 UTC+300',
    locationName: 'Puck Fair',
    address: '505 Broadway, NY 10012',
  },

  tier1: {
    name: 'backer',
    type: 'TIER',
    slug: 'backers',
    description: '$10/month',
    amount: 1000,
    interval: 'month',
    currency: 'USD',
    maxQuantity: 10,
  },

  tier2: {
    name: 'sponsor',
    type: 'TIER',
    slug: 'sponsors',
    description: '$1,000/year sponsorship',
    amount: 10000,
    interval: 'year',
    currency: 'USD',
    maxQuantity: 100,
  },

  tierProduct: {
    name: 'Test T-Shirt',
    type: 'PRODUCT',
    slug: 'tshirt',
    description: 'A testing tshirt',
    amount: 5000,
    interval: null,
    currency: 'USD',
    maxQuantity: 100,
  },

  tierWithCustomFields: {
    name: 'prepaid',
    type: 'TIER',
    slug: 'prepaid',
    description: '$10/month',
    amount: 1000,
    interval: 'month',
    currency: 'USD',
    maxQuantity: 10,
    customFields: [
      {
        name: 'jsonUrl',
        type: 'url',
        required: true,
        label: 'URL of the JSON dependency file',
      },
    ],
  },

  ticket1: {
    name: 'Free ticket',
    type: 'TICKET',
    description: 'free tickets for all',
    amount: 0,
    currency: 'USD',
    maxQuantity: 10,
  },

  ticket2: {
    name: 'paid ticket',
    type: 'TICKET',
    description: '$20 ticket',
    amount: 2000,
    currency: 'USD',
    maxQuantity: 100,
  },

  order1: {
    quantity: 1,
    description: 'I work on bitcoin',
  },

  order2: {
    quantity: 2,
    description: 'I have been working on open source for over a decade',
  },

  order3: {
    quantity: 2,
  },
};
