import copy
import importlib.util
import json
import sys
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import server


class FakeProvider(BaseHTTPRequestHandler):
    delay=0
    invalid=False
    fail=False
    requests=[]

    def do_POST(self):
        import time
        request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.__class__.requests.append(request)
        if self.fail:
            self.send_response(503);self.end_headers();return
        time.sleep(self.delay)
        prompt=json.loads(request['messages'][1]['content'])
        segments=prompt['source_segments']
        source_ids=[segments[0]['id']] if segments else []
        target=prompt['target']
        result={'fields':{'summary':'模型补充摘要','content':'模型补充的节点解释。','relation_basis':'模型补充的关系依据，仍需人工核验。'},'source_ids':source_ids+['s-fabricated'],'note':'测试模型建议，未人工核验。','suggested_edges':[]}
        if prompt['target_kind']=='node':
            other=next((n for n in prompt['nodes'] if n['id']!=target['id']),None)
            if other:result['suggested_edges']=[{'from':other['id'],'to':target['id'],'relation':'补充关联','relation_basis':'候选关系','source_ids':source_ids}]
        content='not-json' if self.invalid else json.dumps(result,ensure_ascii=False)
        payload=json.dumps({'choices':[{'message':{'content':content}}]}).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)

    def log_message(self,*args):pass


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        cls.app=server.create_server(0,cls.temp.name)
        cls.log_patch=patch.object(server.Handler,'log_message',lambda *a:None);cls.log_patch.start()
        cls.thread=threading.Thread(target=cls.app.serve_forever,daemon=True);cls.thread.start()
        cls.provider=ThreadingHTTPServer(('127.0.0.1',0),FakeProvider)
        cls.pthread=threading.Thread(target=cls.provider.serve_forever,daemon=True);cls.pthread.start()
        cls.base=f'http://127.0.0.1:{cls.app.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.app.shutdown();cls.app.server_close();cls.provider.shutdown();cls.provider.server_close();cls.log_patch.stop();cls.temp.cleanup()

    def request(self,path,body=None,method=None,headers=None):
        h={'Content-Type':'application/json',**(headers or {})}
        req=urllib.request.Request(self.base+path,data=json.dumps(body).encode() if body is not None else None,headers=h,method=method)
        try:
            with urllib.request.urlopen(req) as r:return r.status,json.load(r)
        except urllib.error.HTTPError as e:return e.code,json.load(e)

    def test_save_conflict_and_restart_recovery(self):
        status,old=self.request('/api/workspace');self.assertEqual(status,200)
        expected=old['version'];workspace=old['workspace'];workspace['source']['title']='保存恢复测试'
        status,new=self.request('/api/workspace',{'workspace':workspace,'expected_version':expected},'PUT');self.assertEqual(status,200)
        self.assertEqual(server.WorkspaceStore(Path(self.temp.name)).load()['workspace']['source']['title'],'保存恢复测试')
        self.assertEqual(self.request('/api/workspace',{'workspace':workspace,'expected_version':expected},'PUT')[0],409)
        self.assertEqual(self.request('/api/workspace')[1]['version'],new['version'])

    def test_cross_site_and_invalid_graph_refused(self):
        body={'base_url':'','model':''}
        self.assertEqual(self.request('/api/settings',body,'POST',{'Origin':'https://evil.example'})[0],400)
        w=server.read_json(ROOT/'web/demo.json');w['graph']['edges'][0]['to']='missing'
        self.assertEqual(self.request('/api/workspace',{'workspace':w,'expected_version':0},'PUT')[0],400)
        w=server.read_json(ROOT/'web/demo.json');w['graph']['nodes'][1]['id']=w['graph']['nodes'][0]['id']
        self.assertEqual(self.request('/api/assist',{'workspace':w,'target':{'kind':'node','id':w['graph']['nodes'][0]['id']},'mode':'source'},'POST')[0],400)
        w=server.read_json(ROOT/'web/demo.json');w['layout']['positions'][w['graph']['nodes'][0]['id']]['x']='0" onmouseover="alert(1)'
        self.assertEqual(self.request('/api/workspace',{'workspace':w,'expected_version':0},'PUT')[0],400)
        w=server.read_json(ROOT/'web/demo.json');w['graph']['nodes'][0]['source_refs'][0]['excerpt']='伪造的原文'
        self.assertEqual(self.request('/api/workspace',{'workspace':w,'expected_version':0},'PUT')[0],400)
        self.assertEqual(self.request('/api/settings',{'base_url':{'invalid':'value'}},'POST')[0],400)

    def test_model_json_and_evidence_whitelist(self):
        self.app.settings.update({'base_url':f'http://127.0.0.1:{self.provider.server_port}/v1','model':'test-model','api_key':'test-only-provider-key'})
        public=self.request('/api/settings')[1];self.assertNotIn('api_key',public);self.assertTrue(public['has_key'])
        w=server.read_json(ROOT/'web/demo.json');target={'kind':'node','id':w['graph']['nodes'][0]['id']}
        status,result=self.request('/api/assist',{'workspace':w,'target':target,'mode':'model'},'POST')
        self.assertEqual(status,200);self.assertEqual(result['mode'],'model');self.assertIn('summary',result['fields'])
        self.assertTrue(all(r['locator']!='s-fabricated' for r in result['source_refs']))
        for ref in result['source_refs']:
            original=next(s for s in w['source']['segments'] if s['id']==ref['locator']);self.assertEqual(ref['excerpt'],original['text'])
        FakeProvider.invalid=True
        try:self.assertEqual(self.request('/api/assist',{'workspace':w,'target':target,'mode':'model'},'POST')[0],400)
        finally:FakeProvider.invalid=False
        FakeProvider.fail=True
        try:
            status,result=self.request('/api/assist',{'workspace':w,'target':target,'mode':'model'},'POST');self.assertEqual(status,400);self.assertIn('503',result['error'])
        finally:FakeProvider.fail=False

    def test_source_matching_is_explicitly_not_model_output(self):
        w=server.read_json(ROOT/'web/demo.json');target={'kind':'node','id':w['graph']['nodes'][0]['id']}
        status,result=self.request('/api/assist',{'workspace':w,'target':target,'mode':'source'},'POST')
        self.assertEqual(status,200);self.assertEqual(result['mode'],'source');self.assertIn('未调用模型',result['note']);self.assertEqual(result['suggested_edges'],[])

    def test_corrupt_workspace_is_not_silently_replaced(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'default.json';path.write_text('broken',encoding='utf-8');store=server.WorkspaceStore(Path(d))
            with self.assertRaises(ValueError):store.save(server.read_json(ROOT/'web/demo.json'),0)
            self.assertEqual(path.read_text(),'broken')

    def test_nested_modules_persist_and_invalid_hierarchies_are_refused(self):
        workspace = server.read_json(ROOT/'web/demo.json')
        node = workspace['graph']['nodes'][0]['id']
        workspace['graph']['groups'] = [
            {'id': 'g-root', 'label': '主题', 'parent_id': None, 'node_ids': [], 'color': '#4779c8'},
            {'id': 'g-child', 'label': '子模块', 'parent_id': 'g-root', 'node_ids': [node], 'color': '#9465c7'}
        ]
        with tempfile.TemporaryDirectory() as directory:
            store = server.WorkspaceStore(Path(directory))
            store.save(workspace, 0)
            self.assertEqual(store.load()['workspace']['graph']['groups'], workspace['graph']['groups'])
        invalid = copy.deepcopy(workspace)
        invalid['graph']['groups'][0]['parent_id'] = 'g-child'
        with self.assertRaises(server.InputError):
            server.validate_workspace(invalid)
        invalid = copy.deepcopy(workspace)
        invalid['graph']['groups'][1]['node_ids'] = ['n-missing']
        with self.assertRaises(server.InputError):
            server.validate_workspace(invalid)


if __name__=='__main__':unittest.main(verbosity=2)
