"""Drag-first creation journeys. Uses native Chromium drag/drop and pointer input."""
from pathlib import Path
import json
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT));sys.path.insert(0,str(ROOT/'tests'))
import server
from test_editor_api import FakeProvider


def run():
    checks=[];out=ROOT.parent/'output/playwright';out.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory() as temp,patch.object(server.Handler,'log_message',lambda *a:None):
        app=server.create_server(0,temp)
        fixture=server.read_json(ROOT/'web/demo.json')
        fixture.update(graph={'nodes':[],'edges':[]},layout={'positions':{},'zoom':.8},mappings=[],outline=[],evidence_chains=[],pending_suggestions=[])
        app.store.save(fixture,0)
        provider=ThreadingHTTPServer(('127.0.0.1',0),FakeProvider)
        app.settings.update({'base_url':f'http://127.0.0.1:{provider.server_port}/v1','model':'protocol-test-model'})
        FakeProvider.requests=[];FakeProvider.delay=0;FakeProvider.fail=False
        threading.Thread(target=provider.serve_forever,daemon=True).start();threading.Thread(target=app.serve_forever,daemon=True).start()
        errors=[]
        try:
            with sync_playwright() as p:
                browser=p.chromium.launch(headless=True)
                page=browser.new_page(viewport={'width':1536,'height':960},reduced_motion='reduce')
                page.on('pageerror',lambda e:errors.append(str(e)))
                page.goto(f'http://127.0.0.1:{app.server_port}');page.wait_for_load_state('networkidle')
                expect(page.locator('#component-library')).to_be_visible();expect(page.locator('[data-node-kind]')).to_have_count(6)

                def drop(kind,x,y):
                    before=page.locator('.graph-node').count()
                    page.locator('#show-components').click()
                    page.locator(f'[data-node-kind={kind}]').drag_to(page.locator('#viewport'),target_position={'x':x,'y':y})
                    expect(page.locator('.graph-node')).to_have_count(before+1)
                    expect(page.locator('dialog[open]')).to_have_count(0)
                    expect(page.locator('#detail-form input[name=label]')).to_have_value('')
                    selected=page.locator('.graph-node.selected');expect(selected).to_have_count(1)
                    return selected.get_attribute('data-node')

                a=drop('concept',220,220);b=drop('evidence',560,220)
                assert len(FakeProvider.requests)==0
                checks.append('native_component_drop_creates_node_and_opens_sidebar_without_dialog_or_model_request')

                def wire(from_id,to_id,body=False,cancel=False):
                    source=page.locator(f'[data-output="{from_id}"]').bounding_box()
                    target=page.locator(f'[data-node="{to_id}"]' if body else f'[data-input="{to_id}"]').bounding_box()
                    tx=target['x']+target['width']/2;ty=target['y']+target['height']/2
                    page.mouse.move(source['x']+source['width']/2,source['y']+source['height']/2);page.mouse.down();page.mouse.move(tx,ty,steps=12)
                    if cancel:page.keyboard.press('Escape')
                    page.mouse.up()

                wire(a,b);expect(page.locator('.edge-hit')).to_have_count(1);expect(page.locator('dialog[open]')).to_have_count(0)
                expect(page.locator('#detail-form input[name=relation]')).to_have_value('关联')
                assert len(FakeProvider.requests)==0
                checks.append('port_drag_builds_edge_immediately_and_defers_ai_for_unnamed_endpoints')
                wire(a,b);expect(page.locator('.edge-hit')).to_have_count(1);expect(page.locator('#toast')).to_contain_text('已经存在')
                wire(a,a);expect(page.locator('.edge-hit')).to_have_count(1)
                wire(b,a,cancel=True);expect(page.locator('.edge-hit')).to_have_count(1);expect(page.locator('.edge-preview')).to_have_count(0)
                assert not page.locator('#world').evaluate('(e)=>e.classList.contains("connecting")')
                checks.append('duplicate_self_and_escape_do_not_create_edges_or_leave_drag_state')

                page.locator('#detail-form input[name=relation]').fill('支持');page.locator('#detail-form button[type=submit]').click()
                wire(a,b,body=True);expect(page.locator('.edge-hit')).to_have_count(2)
                checks.append('dropping_output_on_target_node_body_also_connects')

                # A result may arrive while the user is typing into a different node.
                page.locator(f'[data-node="{a}"]').click();FakeProvider.delay=.7
                page.locator('#detail-form input[name=label]').fill('互联网补充');page.locator('#detail-form button[type=submit]').click()
                page.locator(f'[data-node="{b}"]').click();page.locator('#detail-form input[name=label]').fill('协议依据（正在填写）')
                expect(page.locator('#assist-status')).to_contain_text('已补充',timeout=10000)
                expect(page.locator('#detail-form input[name=label]')).to_have_value('协议依据（正在填写）')
                assert len(FakeProvider.requests)==1
                checks.append('background_ai_result_keeps_unsaved_sidebar_text_for_another_node')
                FakeProvider.delay=0
                page.locator('#detail-form button[type=submit]').click()
                expect(page.locator('#cancel-ai')).to_be_hidden(timeout=10000)
                expect(page.locator('#detail-form textarea[name=content]')).to_have_value('模型补充的节点解释。',timeout=10000)
                assert len(FakeProvider.requests)==4,len(FakeProvider.requests)
                checks.append('naming_drafts_enriches_nodes_and_waiting_edges_once')

                page.locator('#auto-fill').uncheck()
                for kind,x,y in [('claim',220,420),('section',560,420),('entity',220,610),('other',560,610)]:drop(kind,x,y)
                expect(page.locator('.graph-node')).to_have_count(6)
                assert len(FakeProvider.requests)==4
                checks.append('all_six_component_types_can_be_dragged_without_forcing_content_input')

                page.locator('#zoom-in').click();page.locator('#zoom-in').click()
                page.locator('#viewport').evaluate('(e)=>e.scrollTo(180,120)')
                c=drop('claim',410,370)
                bbox=page.locator(f'[data-node="{c}"]').bounding_box();viewport=page.locator('#viewport').bounding_box()
                assert abs(bbox['x']+bbox['width']/2-(viewport['x']+410))<4,(bbox,viewport)
                assert abs(bbox['y']+bbox['height']/2-(viewport['y']+370))<4,(bbox,viewport)
                checks.append('drop_coordinates_follow_zoom_and_scrolled_world')

                page.locator('#undo').click();expect(page.locator('.graph-node')).to_have_count(6)
                page.locator('#redo').click();expect(page.locator('.graph-node')).to_have_count(7)
                expect(page.locator('#save-status')).to_contain_text('已保存',timeout=10000)
                positions_before_reload=app.store.load()['workspace']['layout']['positions']
                page.reload();page.wait_for_load_state('networkidle');expect(page.locator('.graph-node')).to_have_count(7)
                assert app.store.load()['workspace']['layout']['positions']==positions_before_reload
                assert app.store.load()['workspace']['graph']['nodes'][-1]['needs_details']
                checks.append('unnamed_drafts_support_undo_redo_and_refresh_recovery')

                page.locator('#fit-view').click();page.locator('#auto-fill').uncheck()
                page.locator(f'[data-output="{b}"]').click();page.locator(f'[data-input="{a}"]').click();expect(page.locator('.edge-hit')).to_have_count(3)
                page.locator('#detail-form input[name=relation]').fill('解释');page.locator('#detail-form button[type=submit]').click()
                page.locator(f'[data-output="{b}"]').focus();page.keyboard.press('Enter')
                page.locator(f'[data-input="{a}"]').focus();page.keyboard.press('Enter');expect(page.locator('.edge-hit')).to_have_count(4)
                checks.append('keyboard_and_click_port_connection_remains_available')
                page.locator('#show-components').click()
                page.screenshot(path=str(out/'drag-first-desktop.png'),full_page=True)
                page.set_viewport_size({'width':390,'height':844});page.locator('.mobile-tabs [data-panel=left]').click()
                expect(page.locator('#component-library')).to_be_visible()
                assert page.evaluate('document.documentElement.scrollWidth')<=390
                page.locator('[data-node-kind=concept]').click()
                expect(page.locator('.right-pane')).to_be_visible();expect(page.locator('#detail-form input[name=label]')).to_have_value('')
                page.screenshot(path=str(out/'drag-first-mobile.png'),full_page=True)
                checks.append('mobile_library_click_fallback_opens_content_sidebar_without_modal')
                assert not errors,errors
                browser.close()
        finally:
            app.shutdown();app.server_close();provider.shutdown();provider.server_close();FakeProvider.delay=0
    report={'passed':len(checks),'checks':checks,'page_errors':errors,'real_model_called':False,'model_validation':'OpenAI-compatible HTTP test provider'}
    (out/'drag-first-browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))


if __name__=='__main__':run()
