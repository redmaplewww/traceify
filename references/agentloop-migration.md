# AgentLoop 编辑交互迁移

来源：私有仓库 redmaplewww/agentloop，提交 6af9320，生产发布 0.3.41。恢复包只有编译产物，原始 React/TypeScript 未恢复。此次依据可核对的编译逻辑做有范围的移植与重构，不宣称恢复原始源码。

| 恢复包逻辑 | 本项目入口 | 调整 |
|---|---|---|
| `l0/l1` 坐标约束，`l6` 节点移动 | `web/agentloop-canvas.js: clampPosition`、`bindCanvas` | 去除 1210×520 固定边界，保留正坐标和整数位置，画布随节点扩展 |
| `l9` 端点检查、同类型重复连线判断 | `checkConnection`、`graph.js: addEdge` | 按知识关系名称判断重复，使用稳定 UUID，不绑定控制流/数据流 |
| `da` 三次贝塞尔曲线 | `edgePath` | 保留左右端口方向，并按距离调整曲率 |
| pointer capture、输入输出端口、取消连线 | `bindCanvas` | 指针捕获绑定稳定容器，支持拖线与依次点击，Esc 取消 |
| 工具栏拖入节点 | `app.js` drag/drop 入口 | 沿用 MIME `application/x-agentloop-node-kind`，建立用户命名的知识节点 |
| expectedVersion、AI patch | `server.py`、`graph.js: applyEnrichment` | 原子保存/409 冲突；AI 只补空且拒绝过期上下文，候选边单独确认 |

未迁移 AgentLoop 的身份系统、上架、执行蓝图到 LangGraph 代码生成、worker、对象存储和生产连接配置。Traceify 的节点、来源和证据链仍由自己的图谱契约管理。
