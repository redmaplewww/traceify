# 接入说明

## 选择接入路径

| 需求 | 入口 |
|---|---|
| 快速展示与本地编辑 | 将`standalone/Traceify.html`作为静态页面发布 |
| 在现有页面中嵌入完整工具 | 使用独立HTML作为iframe页面 |
| 接入宿主账户、数据库和模型服务 | 移植`web/`并实现下述API |
| 复用图谱与模块内核 | 导入`graph.js`、`modules.js`和`agentloop-canvas.js` |

## 静态页面和 iframe

独立HTML包含样式、SVG、图谱代码和当前样例。浏览器localStorage保存图谱及属性草稿，模型设置驻留页面会话。直接调用模型服务时，模型接口需要允许该页面来源的跨域请求。

```html
<iframe
  src="/tools/traceify/Traceify.html"
  title="知识图谱工作台"
  style="width:100%;height:calc(100dvh - 64px);border:0"
></iframe>
```

此入口提供完整的独立编辑体验。父应用通过API接入路径实现受控数据交换。Python服务版的响应CSP目前使用`frame-ancestors 'none'`，嵌入该服务时需要由部署方在`Handler.end_headers`或宿主代理中配置受信任的父页面来源。

## 前端源码接入

1. 将`web/`作为完整目录复制到宿主静态目录或构建源码目录，保留相对模块导入和SVG文件。
2. 实现工作区、模型设置和补充接口，返回JSON和对应HTTP状态。
3. 若使用业务前缀，将`integration/api-adapter.mjs`复制到`web/`，在`app.js`的import区后初始化局部fetch适配器。
4. 接入宿主的用户和工作区标识，对存储键和数据读写做实例隔离。

```js
import {createHostFetch} from './api-adapter.mjs';

const fetch = createHostFetch({
  apiBase: '/my-app/api/traceify',
  assetBase: '/my-app/tools/traceify',
  fetchImpl: globalThis.fetch.bind(globalThis)
});
```

该适配器转发`/api/`请求和`/demo.json`，保留调用方的headers、AbortSignal、method和body。鉴权可由宿主的fetchImpl统一注入。前端源文件当前的请求路径如下。

| 请求 | 请求体 | 成功响应 |
|---|---|---|
| GET `/api/workspace` | 无 | `{version, workspace}` |
| PUT `/api/workspace` | `{expected_version, workspace}` | `{version, workspace}` |
| GET `/api/settings` | 无 | `{base_url, model, has_key, configured}` |
| POST `/api/settings` | `{base_url, model, api_key, clear_key}` | 与GET设置相同的公开字段 |
| POST `/api/assist` | `{workspace, target: {kind, id}, mode}` | `{mode, fields, source_refs, suggested_edges, note}` |
| GET `/demo.json` | 无 | 一个workspace对象 |

`mode`取`source`或`model`。字段级定义见[OpenAPI](openapi.json)，完整图谱结构见[图谱契约](../references/graph-contract.md)。

保存采用乐观版本控制。客户端先读取version，提交时使用expected_version。版本不匹配时返回HTTP 409及`{error, latest_version}`。保留该行为可支持现有本地恢复与冲突处理界面。

源文件的`api()`是统一JSON请求和错误处理入口。宿主处理认证失效、HTTP 401和访问控制。Python示例服务监听loopback地址，并检查Host与Origin，可作为本机工作台或后端接口参考。

适配后的源码分支可使用宿主打包器构建。`build_standalone.py`的标准构建入口对应交接包原始模块列表，更新导入与初始化时需要一并维护该构建脚本。

## 工作区和浏览器存储

| 存储键 | 内容 |
|---|---|
| `traceify-workspace-v2` | 服务版浏览器恢复副本与选择状态 |
| `traceify-workspace-v2-property-drafts` | 按原文、对象和字段记录的属性草稿 |
| `traceify-standalone-workspace-v1` | 独立HTML的版本与工作区 |

同一origin内多个用户或工作区实例应使用宿主userId与workspaceId作为前缀。修改位置为`app.js`的CACHE/DRAFT_CACHE和`standalone-api.js`的storageKey。服务器持久化同时使用目标工作区的独立版本号。

`examples/accepted-workspace.json`是已认可样例的版本包装，`examples/module-workspace.json`是可直接写入宿主workspace字段的显式模块样例。将此样例用于新工作区时，由宿主分配workspace ID与版本号。

## 可复用模块与修改位置

| 文件 | 职责 |
|---|---|
| `graph.js` | 数据标准化、编辑、原文映射、证据链、撤销与AI补空约束 |
| `modules.js` | 基于章节和连接的初始分组、父子模块、背景边界和整理布局 |
| `agentloop-canvas.js` | 节点几何、端口手势、连线路径与标签避让 |
| `app.js` | UI状态、API请求、属性草稿与三类视图联动 |
| `style.css` | 工作台令牌、彩色节点、半透明模块与响应布局 |
| `standalone-api.js` | 单文件模式的浏览器存储和直接模型调用 |

核心约束是稳定节点ID、真实source_refs、显式父子模块、可撤销布局和用户字段保护。节点尺寸在`agentloop-canvas.js`中为212×88，相关CSS、端口位置、标签避让和模块布局使用相同几何。

模型补充接口只补空白字段，返回的新关系进入待接受建议。模块归属存于`graph.groups`，父级通过parent_id连接。旧工作区根据原文章节与现有连线建立初始分组，手动调整后进入manual模式。
