Feature: Donation from user to collective

  Scenario: Donation from same currency as Collective's wallet (no fee)
    Given a Collective "Webpack" with a host in "USD"
    And a User "Jane"
    When "Jane" donates "50 USD" to "Webpack"
    Then "Webpack" should have "50 USD" in their balance
    And "Jane" should have "-50 USD" in their balance

  Scenario: Donation from different currency as Collective's wallet (no fee)
    Given a Collective "wwcodedf" with a host in "MXN"
    And a User "Rodrigo"
    And the conversion rate from "USD" to "MXN" is 18.43
    When "Rodrigo" donates "50 USD" to "wwcodedf"
    Then "wwcodedf" should have "922 MXN" in their balance
    And "Rodrigo" should have "-50 USD" in their balance

  Scenario: Donation from different currency as Collective's wallet (with platformFee)
    Given a Collective "magit" with a host in "MXN"
    And a User "Emily"
    And Platform fee is "5%" of the order
    And the conversion rate from "USD" to "MXN" is 18.43
    When "Emily" donates "50 USD" to "magit"
    Then "magit" should have "922 MXN" in their balance
    And "Emily" should have "-50 USD" in their balance
    # And "Platform" should have "2 USD" in their balance

  Scenario: Donation from different currency as Collective's wallet (with hostFee)
    Given a Collective "wwcodedf" with a host in "MXN" and "10%" fee
    And a User "Elizabeth"
    And Host fee is "5%" of the order
    And the conversion rate from "USD" to "MXN" is 18.43
    When "Elizabeth" donates "50 USD" to "wwcodedf"
    Then "wwcodedf" should have "922 MXN" in their balance
    And "Elizabeth" should have "-50 USD" in their balance
    And "wwcodedf-host" should have "2 USD" in their balance
