"""Real Chromium editing journeys against isolated storage and a protocol test model."""
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

OUT=ROOT.parent/'output/playwright';OUT.mkdir(parents=True,exist_ok=True)


def run():
    checks=[]
    with tempfile.TemporaryDirectory() as temp,patch.object(server.Handler,'log_message',lambda *a:None):
        app=server.create_server(0,temp);threading.Thread(target=app.serve_forever,daemon=True).start()
        provider=ThreadingHTTPServer(('127.0.0.1',0),FakeProvider);threading.Thread(target=provider.serve_forever,daemon=True).start()
        try:
            with sync_playwright() as p:
                browser=p.chromium.launch(headless=True)
                context=browser.new_context(viewport={'width':1536,'height':960},reduced_motion='reduce')
                page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
                page.goto(f'http://127.0.0.1:{app.server_port}');page.wait_for_load_state('networkidle')
                expect(page.locator('.graph-node')).to_have_count(11)
                expect(page.locator('#save-status')).to_contain_text('已保存')
                page.screenshot(path=str(OUT/'editor-initial.png'),full_page=True)
                page.locator('#auto-fill').uncheck()

                def create(label):
                    page.locator('#add-node').click()
                    expect(page.locator('dialog[open]')).to_have_count(0)
                    page.locator('#detail-form input[name=label]').fill(label)
                    page.locator('#detail-form button[type=submit]').click()
                    node=page.locator('.graph-node').filter(has_text=label)
                    expect(node).to_be_visible();return node.get_attribute('data-node')

                a=create('互联网补充');b=create('协议补充')
                expect(page.locator('.graph-node')).to_have_count(13)
                checks.append('manual_node_creation')
                page.locator('#fit-view').click()
                node=page.locator(f'[data-node="{a}"]');before=node.evaluate('(e)=>[parseFloat(e.style.left),parseFloat(e.style.top)]')
                box=node.bounding_box();page.mouse.move(box['x']+50,box['y']+20);page.mouse.down();page.mouse.move(box['x']+110,box['y']+55,steps=8);page.mouse.up()
                after=node.evaluate('(e)=>[parseFloat(e.style.left),parseFloat(e.style.top)]')
                assert after[0]>before[0]+20 and after[1]>before[1]+10,(before,after)
                checks.append('pointer_drag_persists_position')

                page.locator('#fit-view').click()
                output=page.locator(f'[data-output="{a}"]').bounding_box();input_port=page.locator(f'[data-input="{b}"]').bounding_box()
                page.mouse.move(output['x']+output['width']/2,output['y']+output['height']/2);page.mouse.down();page.mouse.move(input_port['x']+input_port['width']/2,input_port['y']+input_port['height']/2,steps=12);page.mouse.up()
                expect(page.locator('.edge-hit')).to_have_count(12)
                expect(page.locator('dialog[open]')).to_have_count(0)
                page.locator('#detail-form input[name=relation]').fill('支持')
                page.locator('#detail-form button[type=submit]').click()
                checks.append('port_drag_creates_semantic_edge')

                page.locator(f'[data-node="{a}"]').click()
                page.locator('#detail-form textarea[name=summary]').fill('这段摘要由我手动填写，AI 不应覆盖。')
                page.locator('#detail-form button[type=submit]').click()
                page.locator('#open-settings').click()
                page.locator('#settings-form input[name=base_url]').fill(f'http://127.0.0.1:{provider.server_port}/v1')
                page.locator('#settings-form input[name=model]').fill('protocol-test-model')
                page.locator('#settings-form input[name=api_key]').fill('test-only-provider-key')
                page.locator('#settings-form button[type=submit]').click()
                page.locator('#ai-fill').click()
                expect(page.locator('#assist-status')).to_contain_text('已补充',timeout=10000)
                expect(page.locator('#detail-form textarea[name=summary]')).to_have_value('这段摘要由我手动填写，AI 不应覆盖。')
                expect(page.locator('#detail-form textarea[name=content]')).to_have_value('模型补充的节点解释。')
                expect(page.locator('.evidence-link').first).to_be_visible()
                assert 'test-only-provider-key' not in page.evaluate('JSON.stringify({...localStorage})')
                expect(page.locator('.suggestion')).to_have_count(1)
                expect(page.locator('.edge-hit')).to_have_count(12)
                page.locator('[data-accept]').first.click();expect(page.locator('.edge-hit')).to_have_count(13)
                checks.append('model_fills_only_empty_fields_with_evidence_and_explicit_edge_acceptance')

                page.locator('.evidence-link').first.click()
                expect(page.locator('.source-segment.active')).to_have_count(1)
                page.locator('.source-segment.active').click()
                expect(page.locator('.graph-node.selected').first).to_be_visible()
                checks.append('bidirectional_source_mapping')

                page.locator(f'[data-node="{b}"]').click()
                FakeProvider.delay=.8
                page.locator('#ai-fill').click()
                page.locator('#detail-form input[name=label]').fill('协议补充（人工改名）')
                page.locator('#detail-form button[type=submit]').click()
                expect(page.locator('#assist-status')).to_contain_text('目标已变化',timeout=10000)
                expect(page.locator('#detail-form textarea[name=content]')).to_have_value('')
                FakeProvider.delay=0
                checks.append('stale_model_response_does_not_overwrite_manual_rename')

                page.locator('#delete-item').click();expect(page.locator('.graph-node')).to_have_count(12)
                page.locator('#show-chains').click();expect(page.locator('#outline')).to_contain_text('断链')
                page.locator('#undo').click();expect(page.locator('.graph-node')).to_have_count(13)
                expect(page.locator('.edge-hit')).to_have_count(13)
                page.locator('#show-outline').click()
                checks.append('delete_marks_broken_chain_and_undo_restores_structure')

                # User text is never inserted as markup.
                xss=create('<img src=x onerror=alert(1)>')
                assert page.locator('#node-layer img').count()==0
                expect(page.locator('#save-status')).to_contain_text('已保存',timeout=10000)
                page.reload();page.wait_for_load_state('networkidle');expect(page.locator('.graph-node')).to_have_count(14)
                expect(page.locator(f'[data-node="{b}"] strong')).to_have_text('协议补充（人工改名）')
                saved=app.store.load()['workspace'];assert saved['layout']['positions'][a]['x']==after[0]
                checks.append('safe_text_rendering_and_refresh_recovery')

                page.locator('#auto-fill').check()
                automatic=create('互联网自动补全')
                expect(page.locator('#assist-status')).to_contain_text('已补充',timeout=10000)
                expect(page.locator('#detail-form textarea[name=content]')).to_have_value('模型补充的节点解释。')
                expect(page.locator(f'[data-node="{automatic}"]')).to_contain_text('AI 待核验')
                checks.append('new_manual_node_automatically_fills_remaining_content')

                FakeProvider.fail=True
                failed=create('互联网失败保留')
                expect(page.locator('#assist-status')).to_contain_text('HTTP 503',timeout=10000)
                expect(page.locator(f'[data-node="{failed}"]')).to_have_count(1)
                expect(page.locator('#detail-form textarea[name=content]')).to_have_value('')
                FakeProvider.fail=False
                page.locator('#ai-fill').click()
                expect(page.locator('#assist-status')).to_contain_text('已补充',timeout=10000)
                checks.append('failed_model_request_preserves_manual_node_and_can_retry')

                page.locator(f'[data-node="{b}"]').click();FakeProvider.delay=1
                page.locator('#ai-fill').click();page.locator('#cancel-ai').click()
                expect(page.locator('#assist-status')).to_contain_text('已取消',timeout=10000)
                expect(page.locator('#detail-form textarea[name=content]')).to_have_value('')
                FakeProvider.delay=0
                checks.append('cancelled_model_request_leaves_manual_content_intact')

                page.locator('#auto-fill').uncheck()
                page.locator(f'[data-node="{failed}"]').click()
                page.locator('.merge-details').evaluate('(e)=>e.open=true')
                page.locator('#merge-target').select_option(automatic)
                count=page.locator('.graph-node').count();page.locator('#merge-node').click()
                expect(page.locator('.graph-node')).to_have_count(count-1)
                expect(page.locator(f'[data-node="{failed}"]')).to_have_count(0)
                page.locator('#undo').click();expect(page.locator('.graph-node')).to_have_count(count)
                checks.append('merge_ui_transfers_relations_and_can_be_undone')

                # Two independent contexts must surface optimistic save conflicts.
                expect(page.locator('#save-status')).to_contain_text('已保存',timeout=10000)
                other_context=browser.new_context(viewport={'width':1536,'height':960})
                other=other_context.new_page();other.goto(f'http://127.0.0.1:{app.server_port}');other.wait_for_load_state('networkidle')
                create('本窗口新增')
                expect(page.locator('#save-status')).to_contain_text('已保存',timeout=10000)
                other.locator('#auto-fill').uncheck();other.locator('#add-node').click();other.locator('#detail-form input[name=label]').fill('另一窗口新增');other.locator('#detail-form button[type=submit]').click()
                expect(other.locator('#conflict-banner')).to_be_visible(timeout=10000)
                expect(other.locator('.graph-node').filter(has_text='另一窗口新增')).to_have_count(1)
                assert '另一窗口新增' in other.evaluate('localStorage.getItem("traceify-workspace-v2")')
                checks.append('concurrent_save_conflict_preserves_local_edit')
                other_context.close()

                page.locator('#open-source').click()
                page.locator('#source-form input[name=title]').fill('从新原文开始')
                page.locator('#source-form textarea[name=content]').fill('测试概念是手动整理的起点。\n\n这段原文用于补充测试概念的依据。')
                page.locator('#source-form button[type=submit]').click()
                expect(page.locator('.graph-node')).to_have_count(0)
                fresh=create('测试概念')
                page.locator('#source-match').click()
                expect(page.locator('#assist-status')).to_contain_text('已补充',timeout=10000)
                expect(page.locator('#detail-form textarea[name=content]')).not_to_have_value('')
                # Source replacement, immediate draft creation, sidebar naming, source matching.
                for _ in range(4):page.locator('#undo').click()
                expect(page.locator('#document-title')).to_have_text('互联网')
                checks.append('new_source_blank_graph_manual_start_and_source_matching')

                page.locator(f'[data-node="{a}"]').click()
                page.screenshot(path=str(OUT/'editor-desktop.png'),full_page=True)
                page.set_viewport_size({'width':390,'height':844})
                page.locator('.mobile-tabs [data-panel=right]').click()
                expect(page.locator('.right-pane')).to_be_visible()
                assert page.evaluate('document.documentElement.scrollWidth')<=390
                page.screenshot(path=str(OUT/'editor-mobile.png'),full_page=True)
                page.locator('.mobile-tabs [data-panel=canvas]').click();expect(page.locator('#viewport')).to_be_visible()
                checks.append('mobile_panels_keep_selection_without_page_overflow')
                assert not errors,errors
                context.close();browser.close()
        finally:
            app.shutdown();app.server_close();provider.shutdown();provider.server_close();FakeProvider.delay=0
    report={'checks':checks,'passed':len(checks),'browser':'Chromium via Python Playwright','real_model_called':False,'model_validation':'OpenAI-compatible HTTP protocol test provider','page_errors':errors}
    (OUT/'editor-browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))


if __name__=='__main__':run()
