# pi-think-tool — 领域词汇表

## 工具

**Think (思考工具)**:
在工具调用之间记录当前判断到会话日志。不获取新信息，不修改外部状态。用于工具链中的中途复核——拿到工具结果后、执行下一步前，显式记录推理过程。
_避免使用_: pause tool、reasoning tool

**Env (环境采集工具)**:
记录被操作环境的状态快照到会话日志。纯信息记录，不做校验、不执行命令。Agent 自行用 bash/kubectl/read 采集数据后调用 env 写入日志。供 consequence 等工具扫描使用。
_避免使用_: context tool、state recorder

**Consequence (后果评估工具)**:
在文件写入、命令执行、k8s/git 操作之前，将风险评估委托给独立子模型。返回结构化结果：风险列表 + 判定（proceed/caution/abort）。不阻断操作，仅供 agent 决策参考。
_避免使用_: risk check、pre-flight tool

## 核心概念

**Scope (环境范围)**:
env 工具的分类标签，限定采集的环境信息类型。可选值：`system`（OS/架构）、`k8s`（集群/命名空间）、`git`（分支/远程）、`file`（路径/权限）、`project`（依赖/构建）。
_避免使用_: category、context type

**Proposed Action (拟执行操作)**:
consequence 工具的输入之一，描述 agent 计划执行的操作（类型、目标、细节）。用于子模型评估风险。
_避免使用_: planned change、intended action

**Sub-model (子模型)**:
consequence 调用 `@earendil-works/pi-ai` 的 `complete()` 向独立模型发起推理。与主 agent 模型解耦，偏好 claude-sonnet-4，fallback 到最便宜可用文本模型。
_避免使用_: secondary LLM、risk model

**Decision (风险判定)**:
consequence 子模型的三态输出。`proceed` — 风险可控；`caution` — 有风险需先处理；`abort` — 不应执行。
_避免使用_: risk level、pass/fail
