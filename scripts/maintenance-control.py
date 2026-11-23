#!/usr/bin/env python3
"""Root-only Staging maintenance control, independent of the API/admin UI."""
import argparse
import datetime
import importlib.util
import os
from pathlib import Path

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['status','start','finish','cancel','extend'])
    parser.add_argument('--until',help='End with timezone, e.g. 2026-11-15T02:30:00+03:00')
    args=parser.parse_args()
    if os.geteuid()!=0:parser.error('Run with sudo on the Staging server.')
    spec=importlib.util.spec_from_file_location('installer',Path(__file__).with_name('install-assistant-staging.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    _,_,sql=module.docker_database()
    if args.action=='status':
        print(sql('SELECT row_to_json(m) FROM commerce.maintenance m;'));return
    until=None
    if args.until:
        until=datetime.datetime.fromisoformat(args.until.replace('Z','+00:00'))
        if until.tzinfo is None or until<=datetime.datetime.now(datetime.timezone.utc):parser.error('--until must be a future instant with timezone')
        until=until.isoformat()
    if args.action=='extend' and not until:parser.error('extend requires --until')
    end="'"+until+"'::timestamptz" if until else "clock_timestamp()+interval '1 hour'"
    expression={'start':"state='scheduled',starts_at=clock_timestamp(),ends_at="+end,'extend':'ends_at='+end,'finish':"state='completed'",'cancel':"state='cancelled'"}[args.action]
    where=" AND state='scheduled'" if args.action in ('extend','finish','cancel') else ''
    result=sql("BEGIN; WITH changed AS (UPDATE commerce.maintenance SET "+expression+",revision=revision+1,updated_at=clock_timestamp() WHERE id=true"+where+" RETURNING *) INSERT INTO commerce.maintenance_event(id,revision,actor_id,payload) SELECT gen_random_uuid(),revision,'operator',jsonb_build_object('command',jsonb_build_object('action','"+args.action+"'),'after',row_to_json(changed)) FROM changed; COMMIT; SELECT row_to_json(m) FROM commerce.maintenance m;")
    print(result)
if __name__=='__main__':main()
