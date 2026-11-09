"""Create the editor as one directly openable HTML file, using the saved graph."""
import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def embedded_json(value):
    return json.dumps(value, ensure_ascii=False).replace('<', '\\u003c')


def build(output):
    web = ROOT / 'web'
    demo = json.loads((web / 'demo.json').read_text(encoding='utf-8'))
    saved = ROOT / 'workspaces/default.json'
    workspace = json.loads(saved.read_text(encoding='utf-8'))['workspace'] if saved.exists() else demo
    modules = ['standalone-api.js', 'icons.js', 'agentloop-canvas.js', 'modules.js', 'graph.js', 'app.js']
    code = []
    for name in modules:
        content = (web / name).read_text(encoding='utf-8')
        content = re.sub(r'^import .*?;\s*$', '', content, flags=re.MULTILINE)
        content = re.sub(r'^export ', '', content, flags=re.MULTILINE)
        code.append(content)
    bootstrap = "const fetch = createStandaloneFetch(JSON.parse(document.getElementById('initial-workspace').textContent), JSON.parse(document.getElementById('demo-workspace').textContent));"
    bundle = '(async () => {\n' + bootstrap + '\n' + '\n'.join(code) + '\n})();'
    bundle = bundle.replace('icons.svg#', '#')
    replacements = {
        '本机服务转发模型请求，密钥仅驻留服务进程内存。': '网页直接调用模型接口，密钥仅在当前网页会话中使用。接口需允许浏览器跨域访问。',
        '模型设置已保存到服务进程内存': '模型设置已应用到当前网页会话',
        '已有进程内密钥': '已有会话密钥',
        '服务端版本': '本地已保存版本',
        '载入服务端版本': '载入本地已保存版本',
        '请运行 python traceify/server.py 后访问本机地址。': '请用浏览器重新打开此 HTML 文件。',
    }
    html = (web / 'index.html').read_text(encoding='utf-8')
    html = html.replace('<link rel="stylesheet" href="style.css">', '<style>\n' + (web / 'style.css').read_text(encoding='utf-8') + '\n</style>')
    html = html.replace('<script type="module" src="app.js"></script>', '')
    html = html.replace('icons.svg#', '#')
    for old, new in replacements.items():
        html = html.replace(old, new)
        bundle = bundle.replace(old, new)
    sprite = (web / 'icons.svg').read_text(encoding='utf-8')
    sprite = sprite.replace('<svg ', '<svg width="0" height="0" aria-hidden="true" style="position:absolute;overflow:hidden" ', 1)
    html = html.replace('<body>', '<body>\n' + sprite)
    data = f'<script type="application/json" id="initial-workspace">{embedded_json(workspace)}</script>\n<script type="application/json" id="demo-workspace">{embedded_json(demo)}</script>'
    html = html.replace('</body>', data + '\n<script>\n' + bundle.replace('</script', '<\\/script') + '\n</script>\n</body>')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(html, encoding='utf-8')
    print(output.resolve())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'workspaces/Traceify.html')
    build(parser.parse_args().output)
