Feature: Donation from user to collective

  Scenario: Donation from same currency as Collective's wallet (no fee)
    Given a Collective with a host in "USD"
    When a User donates "50 USD" to Collective
    Then the "Collective" should have "50 USD" in balance
    And the "User" should have "-50 USD" in balance

  Scenario: Donation from different currency as Collective's wallet (no fee)
    Given a Collective with a host in "MXN"
    And the conversion rate from "USD" to "MXN" is 18.43
    When a User donates "50 USD" to Collective
    Then the "Collective" should have "922 MXN" in balance
    And the "User" should have "-50 USD" in balance

  Scenario: Donation from different currency as Collective's wallet (with platformFee)
    Given a Collective with a host in "MXN"
    And Platform Fee is "5%" of the order
    And the conversion rate from "USD" to "MXN" is 18.43
    When a User donates "50 USD" to Collective
    Then the "Collective" should have "922 MXN" in balance
    And the "User" should have "-50 USD" in balance
    And the "Platform" should have "2 USD" in balance

  Scenario: Donation from different currency as Collective's wallet (with hostFee)
    Given a Collective with a host in "MXN"
    And Host Fee is "5%" of the order
    And the conversion rate from "USD" to "MXN" is 18.43
    When a User donates "50 USD" to Collective
    Then the "Collective" should have "922 MXN" in balance
    And the "User" should have "-50 USD" in balance
    And the "Platform" should have "2 USD" in balance
