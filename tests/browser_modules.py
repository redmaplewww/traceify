"""Nested module geometry, migration undo, persistence, and visual style checks."""
from pathlib import Path
import json,sys,tempfile,threading
from unittest.mock import patch
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT));import server
OUT=ROOT.parent/'output/playwright/modules';OUT.mkdir(parents=True,exist_ok=True)

def run():
 checks=[];errors=[];fixture=server.read_json(ROOT/'examples/accepted-workspace.json')['workspace']
 # Always exercise activation with legacy graph data.
 fixture['graph'].pop('groups',None)
 fixture['layout'].pop('module_layout_version',None)
 fixture['layout'].pop('grouping_mode',None)
 with tempfile.TemporaryDirectory() as temp,patch.object(server.Handler,'log_message',lambda *a:None):
  app=server.create_server(0,temp);app.store.save(fixture,0);threading.Thread(target=app.serve_forever,daemon=True).start()
  try:
   with sync_playwright() as p:
    browser=p.chromium.launch();page=browser.new_page(viewport={'width':1536,'height':960},reduced_motion='reduce')
    page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:d.accept())
    page.goto(f'http://127.0.0.1:{app.server_port}');page.wait_for_load_state('networkidle')
    assert page.locator('.module-frame').count()>=3
    expect(page.locator('#save-status')).to_contain_text('已保存',timeout=10000)
    page.locator('#toast').wait_for(state='hidden',timeout=7000)
    page.screenshot(path=str(OUT/'desktop.png'))
    styles=page.evaluate('''()=>({stroke:parseFloat(getComputedStyle(document.querySelector('.edge-line')).strokeWidth),
      vector:getComputedStyle(document.querySelector('.edge-line')).vectorEffect,
      colors:new Set([...document.querySelectorAll('.graph-node')].map(e=>getComputedStyle(e).backgroundColor)).size})''')
    assert styles['stroke']>=3 and styles['vector']=='non-scaling-stroke',styles
    assert styles['colors']>=4,styles
    checks.append('legacy_graph_has_nested_translucent_frames_thicker_edges_and_multiple_node_colors')

    page.locator('#undo').click()
    expect(page.locator('#save-status')).to_contain_text('已保存',timeout=10000)
    assert app.store.load()['workspace']['layout']['positions']==fixture['layout']['positions']
    page.reload();page.wait_for_load_state('networkidle')
    assert app.store.load()['workspace']['layout']['positions']==fixture['layout']['positions']
    checks.append('first_arrangement_is_undoable_and_undo_survives_reload')
    page.locator('#arrange-modules').click()
    page.locator('#auto-fill').uncheck()
    target=page.locator('[data-node=n-tcpip]');target.click()
    page.locator('.new-module').evaluate('(e)=>e.open=true')
    page.locator('#module-name').fill('协议细节')
    parent=page.locator('#module-parent').input_value()
    assert parent
    page.locator('#create-module').click()
    expect(page.locator('.module-header').filter(has_text='协议细节')).to_have_count(1)
    child=page.locator('#node-module').input_value()
    expect(page.locator('#save-status')).to_contain_text('已保存',timeout=10000)
    stored=app.store.load()['workspace'];group=next(g for g in stored['graph']['groups'] if g['id']==child)
    assert group['parent_id']==parent and group['node_ids']==['n-tcpip']
    page.locator('[data-node=n-arpanet]').click();page.locator('#node-module').select_option(child)
    expect(page.locator('#save-status')).to_contain_text('已保存',timeout=10000)
    stored=app.store.load()['workspace'];assert set(next(g for g in stored['graph']['groups'] if g['id']==child)['node_ids'])=={'n-tcpip','n-arpanet'}
    checks.append('create_child_module_and_reassign_nodes_updates_persisted_hierarchy')

    page.locator('#fit-view').click()
    target=page.locator('[data-node=n-tcpip]');box=target.bounding_box()
    frame=page.locator(f'[data-module="{child}"]');before=frame.bounding_box()
    page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2);page.mouse.down();page.mouse.move(box['x']+box['width']/2-60,box['y']+box['height']/2+40,steps=10);page.mouse.up()
    after=frame.bounding_box()
    assert abs(after['x']-before['x'])>10 or abs(after['height']-before['height'])>10,(before,after)
    containment=page.evaluate('''()=>{
     const frames=[...document.querySelectorAll('.module-frame')];const child=frames.find(e=>e.querySelector('strong').textContent==='协议细节');
     const a=child.getBoundingClientRect();return frames.some(e=>{const b=e.getBoundingClientRect();return e!==child&&b.left<=a.left&&b.top<a.top&&b.right>=a.right&&b.bottom>=a.bottom;});
    }''')
    assert containment
    expect(page.locator('#save-status')).to_contain_text('已保存',timeout=10000)
    position=app.store.load()['workspace']['layout']['positions']['n-tcpip']
    page.reload();page.wait_for_load_state('networkidle')
    assert app.store.load()['workspace']['layout']['positions']['n-tcpip']==position
    expect(page.locator('.module-header').filter(has_text='协议细节')).to_have_count(1)
    page.locator('#toast').wait_for(state='hidden',timeout=7000)
    page.screenshot(path=str(OUT/'nested.png'))
    checks.append('dragged_nodes_update_ancestor_frames_and_nested_structure_survives_reload')
    page.set_viewport_size({'width':390,'height':844});page.locator('button[data-panel=canvas]').click()
    assert page.evaluate('document.documentElement.scrollWidth')<=390
    page.locator('button[data-panel=left]').click();expect(page.locator('#mobile-arrange')).to_be_visible()
    page.locator('#mobile-arrange').click();expect(page.locator('#viewport')).to_be_visible()
    page.locator('#toast').wait_for(state='hidden',timeout=7000)
    page.screenshot(path=str(OUT/'mobile.png'));assert not errors,errors
    checks.append('mobile_can_arrange_and_inspect_module_graph_without_page_overflow')
    browser.close()
  finally:app.shutdown();app.server_close()
 result={'passed':len(checks),'checks':checks,'styles':styles,'page_errors':errors,'real_model_called':False}
 (OUT/'browser-report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':run()
