# 图谱编辑器

## 可运行的图谱编辑器

在项目根目录运行（Python 3.11+，无需安装运行依赖）：

```powershell
python server.py --port 8766
```

打开 <http://127.0.0.1:8766>。自带可编辑的互联网长文示例，支持手动添加、修改、拖动、连接、删除和合并节点，撤销/重做，原文双向定位，保存和版本冲突恢复。可粘贴文本或读取 Markdown 建立空图谱。Skill 仍可负责网页读取和语义抽取；此编辑器不自动抓取网页或一次生成整张新图。

2026-11-09 前端使用研究工作台布局，设计基于 Awesome Design Skills / Sleek。左侧石墨导航调用组件、大纲与证据链，56px工具栏集中创建与编辑操作。选中对象的原文依据放在属性表单前，中等窗口使用详情抽屉，窄屏通过顶部面板切换。设计来源见 [Sleek](https://github.com/redmaplewww/awesome-design-skills/tree/main/skills/sleek)。

点击“添加节点”直接创建概念并进入命名。其他类型可从组件库拖放或点击添加。属性草稿在当前浏览器本地暂存，切换节点、原文页签和刷新后可恢复。“保存修改”提交当前对象，顶部“保存”或Ctrl+S可提交当前原文下多个对象的有效草稿。顶部状态会显示待保存的属性草稿。

初次进入采用可读缩放，底部“阅读”恢复100%，“全图”查看整体结构。低缩放概览简化辅助信息并保持标题可读。[standalone/Traceify.html](../standalone/Traceify.html)是已认可图谱的独立版本，可直接打开。

模块以半透明背景框表达总主题、子模块和节点的层级。旧图根据原文章节和已有连线生成初始分组，首次整理的布局支持撤销。点击“整理模块”可再次排列。节点详情的“所属模块”可调整归属，也可新建模块并指定上一级。背景框会跟随节点移动和成员变化，模块及其父级关系随工作区保存。节点采用模块或类型配色，常规连线3px，选中关系4.5px。

- 左侧组件库提供概念、观点、证据、章节、实体和自由节点。拖进画布即建立节点，不弹出创建表单；点击节点在右侧填写内容。键盘或窄屏也可点击组件添加。
- 从节点右侧端口拖到另一个节点（或左侧输入端口），松开立即建立“关联”关系；在右侧修改名称和依据。也可以依次点击两个端口或用 Enter 操作端口，Esc 取消连线。
- 选中节点/边后，在右侧修改名称、内容、依据及原文关联，点击“保存修改”。用户手写过或主动清空的字段不会被自动填充覆盖。
- “填写名称后自动补充空白”默认开启。刚拖入的未命名节点会先保存为草稿，填写名称并保存后才补充；连到未命名节点的关系等待两端命名。配置模型后使用真实模型补充；未配置时只做明确标为“原文匹配”的字面匹配，不冒充 AI。
- 模型补充的字段标为待核验，建议的新关系需要点击“加入图谱”。模型失败、取消、过期响应不会删除手动结构。
- “原文”面板可反向定位节点；“证据链”显示无来源和历史断链。知识图允许循环，大纲按稳定顺序防止循环展开。

模型可通过界面“模型设置”连接任何 OpenAI 兼容服务。地址填写到 `/v1`，或完整 `/chat/completions`；填写真实模型名称。密钥仅驻留本机服务内存，重启后清除，不写入图谱或 localStorage。也可由启动进程提供 `TRACEIFY_AI_BASE_URL`、`TRACEIFY_AI_MODEL`、`TRACEIFY_AI_API_KEY`；兼容 `OPENAI_BASE_URL`、`OPENAI_MODEL`、`OPENAI_API_KEY`。配置后，所选对象、相邻节点名称与相关原文片段会发给该模型服务。

图谱保存于 `workspaces/default.json`，前一版本保存在 `default.bak`；浏览器另有恢复副本。可用 `--data-dir` 指定本地目录。服务仅监听 127.0.0.1，未设计为公开的多用户服务。单图谱上限为含历史在内的 500 个节点、2000 条关系；撤销历史保留最近 60 次操作，页面刷新后不保留内存撤销栈。

出现保存冲突时，不会静默覆盖另一窗口。界面可选择保留本地并基于最新版本保存，或载入服务端版本（原本地数据保留在浏览器冲突副本）。此版本未实现逐字段冲突合并；用户需选择保留哪一份。

## 验证与迁移来源

```powershell
node --test tests/editor.test.mjs
python tests/test_editor_api.py
python tests/browser_editor.py
python tests/browser_drag.py
python tests/browser_design.py
python tests/browser_modules.py
```

浏览器测试需要已安装 Python Playwright 与 Chromium。测试使用临时工作区和本机模型协议替身，不访问生产数据库或使用真实凭证；实际模型质量需连接用户模型后核验。拖拽专项覆盖真实 HTML 拖放、缩放和滚动后的落点、直接建边、占位命名后补空、侧栏输入保护及窄屏替代入口。

交互迁移来源为 AgentLoop 0.3.41 的恢复部署包（`redmaplewww/agentloop@6af9320`）。纯函数、指针捕获、拖放节点、端口连线与曲线规则整理为可维护的 ES 模块；没有把编译产物冒充原始 TSX。详见 [迁移说明](../references/agentloop-migration.md)。

## 接入与设计 Skill

接入路径、API前缀、iframe和用户工作区隔离见[接入说明](../integration/INTEGRATION.md)。
本轮配套[Sleek Skill](../skills/awesome-design-sleek/SKILL.md)包含DESIGN.md与MIT许可。

服务首次启动使用web/demo.json，后续保存到workspaces/default.json。
examples/accepted-workspace.json保留已认可的13节点工作区快照，examples/module-workspace.json提供显式模块样例。

```sh
python -m pip install -r requirements-tests.txt
python -m playwright install chromium
python build_standalone.py --output standalone/Traceify.html
```

重新构建时使用当前workspaces/default.json，尚无保存数据时使用web/demo.json。
