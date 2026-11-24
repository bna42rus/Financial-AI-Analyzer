"""Real PostgreSQL 18 regression: private root bind mount and isolated restore.

CI only. Requires root, Docker, and an already pulled official postgres:18 image.
No application databases, credentials, network, ports, or existing volumes.
"""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time

from cashneuro_ops.common import cleanup_isolated_container, run, sql, start_isolated_postgres
from cashneuro_ops.sizing import SEED


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run this synthetic integration test as root')
    image = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', 'postgres:18']).decode().strip()
    root = Path(tempfile.mkdtemp(prefix='cashneuro-ops-postgres-'))
    try:
        # Reproduce the previous failure before testing the corrected helper.
        name = 'cashneuro-restore-' + secrets.token_hex(8)
        pgdata = root / 'old';pgdata.mkdir(mode=0o700)
        try:
            run(['docker','run','-d','--name',name,'--network','none','--memory','512m','--cpus','0.5',
                 '--label','cashneuro.restore-test=true','--mount','type=bind,src='+str(pgdata)+',dst=/var/lib/postgresql',
                 '-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_USER=cashneuro_restore','--pull','never',image])
            for attempt in range(30):
                state=json.loads(run(['docker','inspect','--format','{{json .State}}',name]))
                if not state['Running']:break
                time.sleep(1)
            assert not state['Running'], 'Old root-owned mount unexpectedly started'
            logs=subprocess.run(['docker','logs',name],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=10,check=True).stdout
            assert b'Permission denied' in logs, 'Expected private parent permission regression'
            print('Reproduced PostgreSQL 18 private parent permission failure',flush=True)
        finally:
            cleanup_isolated_container(name)
        for purpose in ('restore','sizing'):
            name='cashneuro-'+purpose+'-'+secrets.token_hex(8)
            try:
                db=start_isolated_postgres(name,root/purpose,image,'cashneuro_'+purpose)
                inspect=json.loads(run(['docker','inspect',name]))[0]
                assert inspect['HostConfig']['NetworkMode']=='none'
                assert not inspect['HostConfig']['PortBindings']
                assert len(inspect['Mounts'])==1 and inspect['Mounts'][0]['Source']==str(root/purpose)
                assert sql(db,'SHOW data_directory;').strip()=='/var/lib/postgresql'
                assert (root/purpose/'PG_VERSION').exists()
                if purpose=='sizing':
                    sql(db,SEED,timeout=180)
                    assert sql(db,'SELECT count(*) FROM operations;').strip()=='5000'
                    assert sql(db,'SELECT count(*) FROM analyzer_requests;').strip()=='500'
                else:
                    sql(db,'CREATE TABLE synthetic_example(id int PRIMARY KEY); INSERT INTO synthetic_example VALUES(1);')
                    dump=run(['docker','exec',name,'pg_dump','-Fc','-U',db['owner'],'-d','postgres'])
                    sql(db,'CREATE DATABASE synthetic_restored;')
                    run(['docker','exec','-i',name,'pg_restore','--no-owner','--no-privileges','--exit-on-error',
                         '-U',db['owner'],'-d','synthetic_restored'],data=dump)
                    assert sql({**db,'database':'synthetic_restored'},'SELECT count(*) FROM synthetic_example;').strip()=='1'
                print('Real isolated PostgreSQL 18 '+purpose+' check: OK',flush=True)
            finally:
                cleanup_isolated_container(name)
    finally:
        shutil.rmtree(root)


if __name__=='__main__':
    main()
