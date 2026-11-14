-- Explicit staging-only release option. Historical purchases contain immutable snapshots.
SELECT pg_advisory_xact_lock(92044);
WITH defaults(id,name,kind,count,price,quota) AS (VALUES
 ('cashneuro-1w','1 неделя','days',7,'11900',2500),
 ('cashneuro-2w','2 недели','days',14,'21900',5000),
 ('cashneuro-1m','1 месяц','calendar_months',1,'39900',10000),
 ('cashneuro-3m','3 месяца','calendar_months',3,'104900',10000),
 ('cashneuro-6m','6 месяцев','calendar_months',6,'189900',10000)
), expected AS (
 SELECT id,jsonb_build_object('id',id,'name',name,'duration',jsonb_build_object('kind',kind,'count',count),
 'priceMinor',price,'aiQuota',quota,'active',true,'publicVisible',true,'availableForNew',true,'availableForRenewal',true) AS snapshot
 FROM defaults
)
INSERT INTO access.tariff AS t(id,snapshot) SELECT id,snapshot||jsonb_build_object('catalogVersion',1) FROM expected
ON CONFLICT(id) DO UPDATE SET snapshot=t.snapshot||EXCLUDED.snapshot||jsonb_build_object('catalogVersion',COALESCE((t.snapshot->>'catalogVersion')::int,0)+1)
WHERE NOT (t.snapshot @> (EXCLUDED.snapshot-'catalogVersion'));
