-- SELECT ALL Recurring contrubution members with incorrect TierId

select Members.id as "MemberId", Members."TierId", Orders."TierId" as "CorrectTierId"
from
    public."Members" as Members
    inner join public."Orders" as Orders on (Orders."FromCollectiveId" = Members."MemberCollectiveId" and Orders."CollectiveId" = Members."CollectiveId")
    inner join public."Subscriptions" as Subscriptions on (Orders."SubscriptionId" = Subscriptions.id)
where
     Subscriptions."isActive"= true
     and Members."TierId" <> Orders."TierId"



UPDATE public."Members"
SET "TierId"=subquery."TierId"
FROM
    (select Members.id, Orders."TierId"
    from
        public."Members" as Members
        inner join public."Orders" as Orders on (Orders."FromCollectiveId" = Members."MemberCollectiveId" and Orders."CollectiveId" = Members."CollectiveId")
        inner join public."Subscriptions" as Subscriptions on (Orders."SubscriptionId" = Subscriptions.id)
    where
        Subscriptions."isActive"= true
        and Members."TierId" <> Orders."TierId") as subquery
WHERE "Members".id=subquery.id