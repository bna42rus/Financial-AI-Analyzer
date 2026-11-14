-- Operations support can reconcile order states; never expose redirects, saved cards or payment secrets.
CREATE FUNCTION commerce.control_checkout_queue() RETURNS TABLE(
 id uuid,channel text,status text,mode text,tariff text,price_minor text,
 provider_id uuid,created_at timestamptz,paid_at timestamptz
) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT o.id,CASE WHEN o.application_id IS NULL THEN 'renewal' ELSE 'first' END,
        o.state,o.mode,o.tariff->>'name',o.tariff->>'priceMinor',o.provider_id,o.created_at,o.paid_at
 FROM commerce.access_checkout o
 ORDER BY (o.state='reconcile') DESC,o.created_at DESC,o.id LIMIT 200
$$;
REVOKE ALL ON FUNCTION commerce.control_checkout_queue() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce.control_checkout_queue() TO control_api;
