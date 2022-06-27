PayPal API can sometimes be confusing, especially because of the poorly documented changes
between V1 and V2. This document intend to clarify some of these inconsistencies.

# Schema (V1 -> V2)

Name in V1: `Transaction`
Name in V2: Payment > `Capture`
Description: Contains the payment breakdown, matches our `Transactions` table

Name in V1: ???
Name in V2: Payment > `Authorization`

Name in V1: Sales
Name in V2: ???
