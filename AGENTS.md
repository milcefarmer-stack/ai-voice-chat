# AGENTS.md

ai-voice-chat:Node.js 语音对话应用(VAD 免点击 + 流式 LLM/TTS + 可打断 + AEC + 历史对话)。Backlog 见 `开发日志.txt`;本工作流完整参考版见 `docs/开发流程-MattPocock工作流.md`。

## 开发流程(Matt Pocock 工作流,所有功能开发默认遵循)

```
口述想法 → ① grill 拷问 → ② to-spec 规格书 → ③ to-tickets 任务拆分
        → ④ implement(TDD)→ ⑤ code-review(独立会话)
        → ⑥ 定期 improve-codebase 架构大扫除 → 回到 ①
```

对应 skill(`mattpocock-skills:*`):`grill-with-docs`(拷问同时维护 CONTEXT.md/ADR)、`to-spec`、`to-tickets`、`implement`、`code-review`、`improve-codebase-architecture`;大型复杂需求先用 `wayfinder`。

### 六条铁律

1. **共识先行**:共识没达成前禁止写任何代码。一次只问一个问题,每个问题附上你的建议答案,直到所有关键决策用户拍板。
2. **规格无代码**:规格书里禁止出现任何程序代码,只回答"这个功能到底要解决什么"。
3. **按用户功能拆任务**:每个任务 = 数据+逻辑+界面一个完整增量,做完即可点开测试;禁止按技术层拆(先数据库→后端→前端)。
4. **TDD 顺序不可反**:先写测试并跑出红灯,再写实现直到变绿;禁止先写实现后补测试,禁止照着实现反配必过的测试。
5. **审查开新会话**:code-review 必须在全新会话(不带写代码的记忆)中按《重构》12 种坏味道逐项检查,只报告有实据的问题。重点:Shotgun Surgery、Feature Envy、Data Clumps。
6. **定期架构大扫除**:每隔几天对每个模块问"删掉它、让主程序接管会怎样?"——删掉天下大乱 = 深模块,留下;删掉反而清爽 = 浅模块,清掉。

### 完成标准

功能做完 = 测试绿灯 + 新会话 code-review 无未决问题 + 用户可实际操作验收。
