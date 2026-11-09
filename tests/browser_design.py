"""Studio layout and the specific editing regressions from the frontend audit."""
from pathlib import Path
import hashlib
import json
import sys
import tempfile
import threading
from unittest.mock import patch

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server

OUT = ROOT.parent / 'output/playwright/studio'


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    checks, layouts, errors = [], [], []
    fixture = server.read_json(ROOT / 'examples/accepted-workspace.json')['workspace']
    with tempfile.TemporaryDirectory() as temp, patch.object(server.Handler, 'log_message', lambda *args: None):
        app = server.create_server(0, temp)
        app.store.save(fixture, 0)
        threading.Thread(target=app.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch()
                page = browser.new_page(viewport={'width': 1536, 'height': 960}, reduced_motion='reduce')
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('dialog', lambda dialog: dialog.accept())
                page.goto(f'http://127.0.0.1:{app.server_port}')
                page.wait_for_load_state('networkidle')
                page.locator('#readable-view').click()
                page.screenshot(path=str(OUT / 'desktop.png'))

                for width, height in [(1536, 960), (1366, 768), (1180, 800), (901, 800), (900, 800), (768, 900), (390, 844), (320, 720)]:
                    page.set_viewport_size({'width': width, 'height': height})
                    if width <= 760:
                        page.locator('button[data-panel=canvas]').click()
                    info = page.evaluate('''()=>{
                        const viewport=document.querySelector('#viewport').getBoundingClientRect();
                        const pane=document.querySelector('.canvas-pane').getBoundingClientRect();
                        const scale=new DOMMatrix(getComputedStyle(document.querySelector('#world')).transform).a;
                        return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,
                          canvasWidth:viewport.width,canvasHeight:viewport.height,toolbarHeight:viewport.top-pane.top,
                          titlePx:parseFloat(getComputedStyle(document.querySelector('.graph-node strong')).fontSize)*scale,
                          metaPx:parseFloat(getComputedStyle(document.querySelector('.node-meta')).fontSize)*scale};
                    }''')
                    assert not info['overflow'], info
                    assert info['toolbarHeight'] <= 64, info
                    assert info['titlePx'] >= 14, info
                    assert info['metaPx'] >= 12, info
                    assert info['canvasHeight'] >= 450, info
                    page.screenshot(path=str(OUT / f'canvas-{width}.png'))
                    layouts.append(info)
                widths = {item['width']: item['canvasWidth'] for item in layouts}
                assert abs(widths[901] - widths[900]) <= 2
                checks.append('eight_sizes_readable_text_compact_toolbar_and_continuous_tablet_layout')

                page.set_viewport_size({'width': 1536, 'height': 960})
                page.locator('#auto-fill').uncheck()
                nodes = page.locator('.graph-node')
                first_id = nodes.first.get_attribute('data-node')
                second_id = nodes.nth(1).get_attribute('data-node')
                first = page.locator(f'[data-node="{first_id}"]')
                second = page.locator(f'[data-node="{second_id}"]')
                first.click()
                page.locator('input[name=label]').fill('审查回归：已暂存的名称')
                page.locator('textarea[name=summary]').fill('切换页签与节点时保留这段草稿。')
                expect(page.locator('#save-status')).to_contain_text('待保存')
                page.locator('#tab-source').click()
                page.locator('#tab-details').click()
                expect(page.locator('input[name=label]')).to_have_value('审查回归：已暂存的名称')
                second.click()
                page.locator('textarea[name=summary]').fill('另一个节点的属性草稿。')
                first.click()
                expect(page.locator('textarea[name=summary]')).to_have_value('切换页签与节点时保留这段草稿。')
                checks.append('field_drafts_survive_source_tab_and_node_switches_with_honest_save_state')

                page.reload()
                page.wait_for_load_state('networkidle')
                expect(page.locator('input[name=label]')).to_have_value('审查回归：已暂存的名称')
                second.click()
                expect(page.locator('textarea[name=summary]')).to_have_value('另一个节点的属性草稿。')
                page.locator('textarea[name=summary]').focus()
                page.keyboard.press('Control+s')
                expect(page.locator('#save-status')).to_contain_text('已保存', timeout=10000)
                stored = app.store.load()['workspace']['graph']['nodes']
                by_id = {node['id']: node for node in stored}
                assert by_id[first_id]['label'] == '审查回归：已暂存的名称'
                assert by_id[second_id]['summary'] == '另一个节点的属性草稿。'
                assert page.evaluate('JSON.parse(localStorage.getItem("traceify-workspace-v2-property-drafts")).length') == 0
                checks.append('drafts_survive_reload_and_keyboard_save_submits_multiple_objects')

                before = nodes.count()
                page.locator('#add-node').click()
                expect(nodes).to_have_count(before + 1)
                expect(page.locator('input[name=label]')).to_have_value('')
                expect(page.locator('dialog[open]')).to_have_count(0)
                page.locator('input[name=label]').fill('新增证据节点')
                page.locator('select[name=kind]').select_option('evidence')
                page.locator('#detail-form button[type=submit]').click()
                expect(page.locator('.graph-node.selected')).to_have_attribute('data-kind', 'evidence')
                expect(page.locator('.identity-icon use')).to_have_attribute('href', 'icons.svg#evidence')
                expect(page.locator('.type-badge')).to_have_text('证据')
                color = page.locator('.type-badge').evaluate('(e)=>getComputedStyle(e).getPropertyValue("--node-color").trim()')
                assert color == '#248b79', color
                checks.append('add_node_creates_immediately_and_inspector_type_matches_canvas')

                evidence = page.locator('.evidence-section').bounding_box()
                inspector = page.locator('#inspector').bounding_box()
                assert evidence['y'] >= inspector['y'] and evidence['y'] + evidence['height'] <= inspector['y'] + inspector['height']
                page.locator('#tab-source').click()
                segment = page.locator('.source-segment').first
                segment.focus()
                page.keyboard.press('Space')
                expect(segment).to_have_class('source-segment active', timeout=5000)
                page.locator('#tab-details').click()
                checks.append('evidence_precedes_form_and_native_source_buttons_support_space')

                page.locator('#fit-view').click()
                overlap = page.evaluate('''()=>{
                    const nodes=[...document.querySelectorAll('.graph-node')].map(e=>e.getBoundingClientRect());
                    return [...document.querySelectorAll('.edge-label')].filter(label=>{
                        const a=label.getBoundingClientRect();
                        return nodes.some(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 &&
                          Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1);
                    }).length;
                }''')
                assert overlap == 0, overlap
                title_px = page.locator('.graph-node strong').first.evaluate('e=>parseFloat(getComputedStyle(e).fontSize)*new DOMMatrix(getComputedStyle(document.querySelector("#world")).transform).a')
                assert title_px >= 13.9, title_px
                page.screenshot(path=str(OUT / 'overview.png'))
                checks.append('relationship_labels_avoid_nodes_and_overview_titles_remain_readable')

                page.locator('#readable-view').click()
                expect(page.locator('#zoom-label')).to_have_text('100%')
                page.locator('#show-components').click()
                expect(page.locator('#library-pane')).to_be_visible()
                page.locator('#close-library').click()
                expect(page.locator('#library-pane')).to_be_hidden()
                assert page.locator('#library-pane').evaluate('(e)=>e.inert')
                checks.append('reading_reset_and_on_demand_library_preserve_canvas_space')

                page.set_viewport_size({'width': 390, 'height': 844})
                page.locator('button[data-panel=left]').click()
                expect(page.locator('#mobile-search')).to_be_visible()
                page.locator('#mobile-search').fill('新增证据')
                expect(page.locator('#outline')).to_contain_text('新增证据节点')
                page.locator('#mobile-search').fill('')
                page.locator('#mobile-import').click()
                expect(page.locator('#source-dialog')).to_be_visible()
                page.locator('#source-dialog [data-close]').click()
                page.locator('button[data-panel=right]').click()
                assert not page.locator('#details-pane').evaluate('(e)=>e.inert')
                page.locator('#configure-model').click()
                expect(page.locator('#settings-dialog')).to_be_visible()
                assert page.locator('#settings-dialog').bounding_box()['width'] <= 390
                page.locator('#settings-dialog [data-close]').first.click()
                page.screenshot(path=str(OUT / 'mobile-details.png'))
                checks.append('mobile_search_import_model_setup_and_panel_focus_are_reachable')
                assert not errors, errors
                browser.close()
        finally:
            app.shutdown()
            app.server_close()
    result = {'passed': len(checks), 'checks': checks, 'layouts': layouts, 'page_errors': errors,
              'real_model_called': False,
              'sha256': {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
                         for path in [ROOT/'web/index.html', ROOT/'web/style.css', ROOT/'web/app.js', ROOT/'web/agentloop-canvas.js', ROOT/'web/modules.js', ROOT/'web/icons.svg']}}
    (OUT / 'studio-browser-report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    run()
