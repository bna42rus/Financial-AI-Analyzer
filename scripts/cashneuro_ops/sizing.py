"""A reproducible synthetic profile, measured in an isolated PostgreSQL container.

Representative storage model, not a claim to reproduce every application table.
The output explicitly separates shared cluster overhead from profile relations.
"""
import json
import os
from pathlib import Path
import re
import secrets
import shutil

from .common import STATE, OpsError, cleanup_isolated_container, database, emit, locked, private_dir, private_write, run, sql, start_isolated_postgres

SEED = r"""
SET statement_timeout='120s';
CREATE TABLE operations(id uuid PRIMARY KEY,user_id text NOT NULL,source_id uuid NOT NULL,
 semantics jsonb NOT NULL,corrections jsonb NOT NULL,comment text NOT NULL,revision bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ON operations(user_id,created_at);
CREATE INDEX ON operations(user_id,((semantics->>'categoryId')));
INSERT INTO operations SELECT md5('operation-'||i)::uuid,'synthetic-owner',md5('source-'||i)::uuid,
 jsonb_build_object('categoryId',md5('category-'||(i%80)),'counterpartyId',md5('counterparty-'||(i%150)),
 'role','expense','source','personal_rule','confidence',100,'amountMinor',(i*7919)%2000000),
 CASE WHEN i%7=0 THEN jsonb_build_object('comment','Тестовая ручная правка '||i) ELSE '{}'::jsonb END,
 CASE WHEN i%5=0 THEN 'Тестовый комментарий '||i ELSE '' END,0,now()-(i||' hours')::interval
FROM generate_series(1,5000)i;
CREATE TABLE source_observations(id uuid PRIMARY KEY,user_id text NOT NULL,operation_id uuid NOT NULL,
 bank_ref text NOT NULL,payload jsonb NOT NULL);
CREATE INDEX ON source_observations(user_id,operation_id);
INSERT INTO source_observations SELECT md5('source-'||i)::uuid,'synthetic-owner',md5('operation-'||((i-1)%5000+1))::uuid,
 md5('bank-'||i)||md5('ref-'||i),jsonb_build_object('date','2026-01-01','amountMinor',i*97,
 'currency','RUB','merchant','Тестовый магазин '||(i%150),'description','Синтетическая покупка '||i,
 'accountId',md5('account-'||(i%8)),'versions',jsonb_build_object('parser','synthetic/1','bank','test'))
FROM generate_series(1,6000)i;
CREATE TABLE import_rows(id uuid PRIMARY KEY,user_id text NOT NULL,file_id uuid NOT NULL,ordinal int NOT NULL,
 observation_id uuid NOT NULL,status text NOT NULL,evidence jsonb NOT NULL);
CREATE INDEX ON import_rows(user_id,file_id,ordinal);
INSERT INTO import_rows SELECT md5('row-'||i)::uuid,'synthetic-owner',md5('file-'||((i-1)/300))::uuid,
 (i-1)%300+1,md5('source-'||i)::uuid,'imported',jsonb_build_object('event','purchase','merchant','Тестовый магазин '||(i%150))
FROM generate_series(1,6000)i;
CREATE TABLE dictionaries(kind text NOT NULL,id uuid NOT NULL,user_id text NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(kind,id));
INSERT INTO dictionaries SELECT 'counterparty',md5('counterparty-'||i)::uuid,'synthetic-owner',jsonb_build_object('name','Тестовый контрагент '||i) FROM generate_series(1,150)i;
INSERT INTO dictionaries SELECT 'category',md5('category-'||i)::uuid,'synthetic-owner',jsonb_build_object('name','Категория '||i,'role','expense') FROM generate_series(1,80)i;
INSERT INTO dictionaries SELECT 'account',md5('account-'||i)::uuid,'synthetic-owner',jsonb_build_object('name','Счёт '||i,'currency','RUB') FROM generate_series(1,8)i;
INSERT INTO dictionaries SELECT 'rule',md5('rule-'||i)::uuid,'synthetic-owner',jsonb_build_object('name','Правило '||i,'priority',i,
 'conditions',jsonb_build_object('merchantContains','Тестовый магазин '||i),
 'assignments',jsonb_build_object('categoryId',md5('category-'||(i%80)))) FROM generate_series(1,40)i;
CREATE TABLE actions(id uuid PRIMARY KEY,user_id text NOT NULL,preview jsonb NOT NULL,result jsonb NOT NULL,undo_patch jsonb NOT NULL);
INSERT INTO actions SELECT md5('edit-'||i)::uuid,'synthetic-owner',jsonb_build_object('operationId',md5('operation-'||i)),
 jsonb_build_object('changed',1),jsonb_build_object('before',jsonb_build_object('category','Старая категория','comment','Прежнее значение '||i))
FROM generate_series(1,300)i;
INSERT INTO actions SELECT md5('bulk-'||i)::uuid,'synthetic-owner',jsonb_build_object('count',100),jsonb_build_object('changed',100),
 (SELECT jsonb_agg(jsonb_build_object('id',md5('operation-'||(i*100+j)),'before',jsonb_build_object('role','expense','categoryId',md5(j::text),'comment','Исходный комментарий '||j))) FROM generate_series(1,100)j)
FROM generate_series(1,10)i;
CREATE TABLE analyzer_requests(id uuid PRIMARY KEY,user_id text NOT NULL,chat_id uuid NOT NULL,input jsonb NOT NULL,reply jsonb NOT NULL,receipt jsonb NOT NULL);
CREATE INDEX ON analyzer_requests(user_id,chat_id);
INSERT INTO analyzer_requests SELECT md5('request-'||i)::uuid,'synthetic-owner',md5('chat-'||((i-1)/50))::uuid,
 jsonb_build_object('question','Сколько потрачено в тестовой категории '||(i%80),'conversation',history),
 jsonb_build_object('answer','Синтетический ответ '||i,'amountMinor',i*7919),
 jsonb_build_object('conversation',history,'calls',jsonb_build_array(jsonb_build_object('state','received','inputTokens',3000,'outputTokens',200)))
FROM generate_series(1,500)i CROSS JOIN LATERAL (
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',md5((i*100+j)::text),'question','Синтетический вопрос '||j,
 'answer','Пример ответа для тестового чата: '||repeat(md5((i*100+j)::text),12))), '[]'::jsonb) AS history
 FROM generate_series(1,(i-1)%50)j
)h;
CREATE TABLE usage_receipts(id uuid PRIMARY KEY,user_id text NOT NULL,input_tokens int,output_tokens int,cost_atoms bigint,created_at timestamptz DEFAULT now());
CREATE INDEX ON usage_receipts(user_id,created_at);
INSERT INTO usage_receipts SELECT md5('usage-'||i)::uuid,'synthetic-owner',3000,200,1234567,now() FROM generate_series(1,500)i;
VACUUM ANALYZE;
"""


def benchmark():
    with locked():
        memory = re.search(r'^MemAvailable:\s+(\d+) kB', Path('/proc/meminfo').read_text(), re.M)
        if not memory or int(memory[1]) < 768 * 1024:
            raise OpsError('BENCHMARK_MEMORY_HEADROOM_LOW')
        live = database('staging')
        root = private_dir(STATE / 'sizing-work')
        if list(root.iterdir()):
            raise OpsError('PREVIOUS_BENCHMARK_REQUIRES_REVIEW')
        container = 'cashneuro-sizing-' + secrets.token_hex(8)
        try:
            db = start_isolated_postgres(container, root / 'pgdata', live['image'], 'cashneuro_sizing')
            before = int(sql(db, 'SELECT pg_database_size(current_database());'))
            emit('synthetic-sizing', status='GENERATING', operations=5000, analyzerRequests=500)
            sql(db, SEED, timeout=180)
            tables = json.loads(sql(db, "SELECT json_agg(t) FROM (SELECT relname,pg_total_relation_size(relid) AS bytes,pg_indexes_size(relid) AS index_bytes,n_live_tup AS rows FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC)t;"))
            after = int(sql(db, 'SELECT pg_database_size(current_database());'))
            with (root / 'profile.dump').open('xb') as stream:
                os.chmod(root / 'profile.dump', 0o600)
                run(['docker', 'exec', container, 'pg_dump', '-Fc', '-U', db['owner'], '-d', db['database']], output=stream, timeout=180)
            dump = (root / 'profile.dump').stat().st_size
            result = {'version': 'synthetic-storage-model/1', 'applicationSchemaBenchmark': False,
                      'profile': {'operations': 5000, 'sourceObservations': 6000, 'importRows': 6000,
                                  'rules': 40, 'counterparties': 150, 'categories': 80, 'accounts': 8,
                                  'individualEdits': 300, 'bulkEdits': 10, 'analyzerRequests': 500},
                      'sharedDatabaseBytesBefore': before, 'databaseGrowthBytes': after - before,
                      'profileRelationsBytes': sum(x['bytes'] for x in tables), 'dumpBytes': dump,
                      'tables': tables, 'actualApplicationUsageStillRequiresMeasurement': True,
                      'nineCopiesWith30PercentReserveForUsers': {
                          str(n): dump * n * 9 * 13 // 10 + 500_000_000 for n in (1, 10, 30, 100)}}
            private_write(STATE / 'synthetic-sizing.json', json.dumps(result))
            emit('synthetic-sizing-complete', **result)
            return result
        finally:
            try:
                cleanup_isolated_container(container)
            except Exception:
                emit('isolated-cleanup-required', container=container)
                raise OpsError('ISOLATED_CONTAINER_CLEANUP_REQUIRED') from None
            shutil.rmtree(root)
