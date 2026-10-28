# pi-events-daemon wiki — 持久知识层

仿 `~/skills/wiki/`（WikiSkill 范式）：在一次性执行轨迹和可回滚的代码之间，加一层
**持续累积、永不回滚**的结构化知识。本项目（中心事件 daemon）的研究、参考、决策
依据都沉淀在这里——下一次站在已有知识之上，不从零考古。

## 目录

```
docs/wiki/pi-events-daemon/
├── README.md        # 本文件：定位 + 索引
├── patterns.md      # 根因级模式条目（状态: open / absorbed-into-spec / closed）
├── store-debugging.md # store.db 调试指针（路径/表结构/脏数据判读）
├── references.md    # 研究对象清单：每个对象读什么、证据在哪（file:line）
└── logs.md          # effort 运行日志（每次一行）
```

## 权威文档链（wiki 之外的事实源）

| 文档 | 内容 |
|---|---|
| `intent/pi-events-daemon.md` | effort intake（问题/产出/约束/裁定记录） |
| GitHub map [#16](https://github.com/peachest/pi-packages/issues/16) | wayfinder map（Decisions-so-far 索引） |
| `docs/research/pi-events-daemon-delivery.md` | T1 投递调研 + bg_run 丢通知根因 + pi-subagents 对比附录 |
| `docs/research/pi-events-daemon-form-factors.md` | T5 常驻进程先例 + XDG 路径布局 |
| `packages/prototype-events-daemon/` | API 形状原型（9 场景测试即可执行规格） |
| `~/tmp/pi-events-daemon-architecture.html` | 蓝图风格决议图 |
| `~/tmp/longtask-scan-v2.json` | 长任务挖掘原始数据（6380 条） |
