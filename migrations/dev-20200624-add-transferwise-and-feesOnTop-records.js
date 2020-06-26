'use strict';

const SQL = ` 
  BEGIN;

  -- TransferWise
  --
  -- Connect Open Collective Host to TransferWise so we can render accept-financial-contributions form
  INSERT INTO "ConnectedAccounts"
  (id, service, username, "clientId", "token", "data", "createdAt", "updatedAt", "deletedAt", "CreatedByUserId", "CollectiveId", "refreshToken", settings)
  VALUES(2134, 'transferwise', NULL, NULL, '71114204-94e4-48c0-84d7-6ee20551f992', '{"id": 6221, "type": "business", "details": {"abn": null, "acn": null, "arbn": null, "name": "Open Collective", "webpage": null, "companyRole": "OWNER", "companyType": "LIMITED", "primaryAddress": 7197510, "businessCategory": "IT_SERVICES", "registrationNumber": "07209813", "businessSubCategory": null, "descriptionOfBusiness": "IT_SERVICES"}}', NULL, '2020-06-08 09:47:30.992', NULL, 666, 8674, NULL, NULL)
  ON CONFLICT DO NOTHING;

  -- Fees on Top
  --
  -- Create Open Collective and Open Collective Inc so we can create feesOnTop transactions
  INSERT INTO "Collectives"
  (id, "name", description, currency, "createdAt", "updatedAt", "deletedAt", "isActive", "longDescription", image, slug, website, "twitterHandle", mission, "backgroundImage", "hostFeePercent", settings, "data", tags, "isSupercollective", "LastEditedByUserId", "CreatedByUserId", "HostCollectiveId", "ParentCollectiveId", "type", "startsAt", "endsAt", "locationName", address, timezone, "maxAmount", "maxQuantity", "geoLocationLatLong", company, "expensePolicy", "githubHandle", "countryISO", "deactivatedAt", "isPledged", "isIncognito", "approvedAt", "isHostAccount", plan, "platformFeePercent")
  VALUES(1, 'Open Collective', 'We are building tools in open source to organize the Internet generation', 'USD', '2015-12-12 22:14:54.028', '2020-02-17 11:19:59.251', NULL, true, '', 'https://cldup.com/rdmBCmH20l.png', 'opencollective', 'https://opencollective.com', 'opencollect', 'We are on a mission to give more economic power to communities around the world.', NULL, 5.0, '{"goals": [{}], "editor": "html", "features": {"conversations": true}, "githubOrg": "opencollective"}', NULL, NULL, false, 30, 8, 8686, NULL, 'COLLECTIVE', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '', NULL, NULL, NULL, false, false, '2016-01-31 22:00:00.000', false, NULL, 5.0)
  ON CONFLICT DO NOTHING;
  INSERT INTO "Collectives"
  (id, "name", description, currency, "createdAt", "updatedAt", "deletedAt", "isActive", "longDescription", image, slug, website, "twitterHandle", mission, "backgroundImage", "hostFeePercent", settings, "data", tags, "isSupercollective", "LastEditedByUserId", "CreatedByUserId", "HostCollectiveId", "ParentCollectiveId", "type", "startsAt", "endsAt", "locationName", address, timezone, "maxAmount", "maxQuantity", "geoLocationLatLong", company, "expensePolicy", "githubHandle", "countryISO", "deactivatedAt", "isPledged", "isIncognito", "approvedAt", "isHostAccount", plan, "platformFeePercent")
  VALUES(8686, 'Open Collective Inc', 'We are on a mission to create a new generation of association, transparent by design', 'USD', '2016-01-15 16:58:42.969', '2020-05-14 00:24:41.766', NULL, false, NULL, 'https://opencollective-production.s3-us-west-1.amazonaws.com/8aa714c0-79fa-11e7-9a37-35a8ed456d67.png', 'opencollectiveinc', 'https://opencollective.com', 'opencollect', NULL, 'https://opencollective-production.s3.us-west-1.amazonaws.com/3a775280-51cf-11ea-98f4-7b0e658061d2.png', 0.0, '{"goals": [{}], "editor": "html", "features": {"transferwise": true, "paypalPayouts": true}, "collectivePage": {"background": {"crop": {"x": 318.31637188177433, "y": 92.74585450409845}, "zoom": 1.3300000000000027}, "primaryColor": "#1F3993"}, "hideCreditCardPostalCode": true, "virtualCardsMaxDailyCount": 500, "virtualCardsMaxDailyAmount": 500000}', '{"W9": {"receivedFromUserIds": [15873, 12155, 12457, 10562, 5133, 86, 30, 488, 3602, 2, 20162, 4829, 25928, 24013, 13511, 10655, 15318, 29687, 36137, 27226, 33061, 15319, 34258], "requestSentToUserIds": [2, 15873, 12155, 12457, 10562, 5133, 86, 86, 30, 86, 488, 488, 488, 488, 488, 488, 3602, 2, 20162, 4829, 25928, 24013, 13511, 10655, 15318, 29687, 36137, 33061, 15319, 27226, 38984, 34258, 46576]}, "plan": {"addedFundsLimit": null}}', NULL, false, 3602, 30, NULL, NULL, 'ORGANIZATION', NULL, NULL, NULL, '340 S Lemon Ave #3717, Walnut, CA 91789', NULL, NULL, NULL, NULL, NULL, '', NULL, 'US', NULL, false, false, NULL, true, 'owned', NULL)
  ON CONFLICT DO NOTHING;
  -- Make Open Collective Host and RailGirlsAtlanta compatible with feesOnTop
  UPDATE "Collectives" SET "settings" = '{ "apply": true, "feesOnTop": true }' WHERE id = 8674;
  UPDATE "Collectives" SET "platformFeePercent" = 0, "hostFeePercent" = 0 WHERE id = 28;

  COMMIT;
`;

module.exports = {
  up: async (queryInterface, Sequelize) => {
    if (process.env.NODE_ENV === undefined || process.env.NODE_ENV === 'development') {
      return queryInterface.sequelize.query(SQL);
    }
  },

  down: async () => {},
};
