# World Engine 详情

World Engine 把开放世界 RP 里最容易漂移的部分交给代码：时间、日程、触发、暗线、变量、骰子、NPC 决策。
它通过 DSH 工具接入角色扮演流程，不渲染界面；叙述、文风与状态卡由角色卡/预设负责。

## 使用方式

1. 插件启用后，在角色扮演预设的工具管理里加入 `world_*` 工具（配套预设已加好）。
2. 每轮开始调用 `world_state` 读取权威状态；若提示未初始化，先 `world_init`（配套预设会传 `worldId="deutsches-reich-canon"` 与开场白对应的 `playerName/location/startTime`）。
3. 玩家行动涉及时间、移动、不确定结果、变量后果时，分别调用
   `world_tick` / `world_move` / `world_dice` / `world_apply`。
4. 需要 NPC 是否在场、在做什么时调用 `world_npc`；关键 NPC 的关键时刻用 `world_npc_act`。
5. 把引擎返回的「状态行」原样放进 `<status>` 状态块，日期/时间/地点/在场与引擎保持一致。
6. 自由场景：如果开局地点不在 `worlds/*.json` 里（伦敦、巴黎、自创房间），`world_init` 传 `locationName`；之后 `world_move` 可传 `locationName` 切换自由场景，或传 `locationId + minutes` 回到已知地点。自由场景里时间、变量、暗线照常推进，但没有固定出口与预设 NPC 站位。
7. 外部剧情存档：每 8–12 轮或章节收束时调用 `world_memory { action:"save", ... }`；用户说“读取存档/回顾”时调用 `{ action:"read" }`。默认写到 `E:\DS Work Space\1\ElecKoi-德意志帝国-总集版\剧情存档\`，可用 `WORLD_ENGINE_MEMORY_DIR` 覆盖。

## 数据

- 内置世界：`worlds/deutsches-reich-canon.json` —— 《德意志帝国 · 2025（总集版）》，21 地点、20 NPC、10 变量、15 触发器、6 条暗线；依据《德意志帝国 · 世界观与人物设定总集》。
- 旧版《黄昏档案》的世界数据已删除。
- 状态按 DSH 会话持久化在 profile 的 `world-engine/<sessionId>.json`；退出重开继续。
- 外部存档：Windows 默认 `E:\DS Work Space\1\ElecKoi-德意志帝国-总集版\剧情存档\`；Android 默认应用私有 profile 的 `world-engine/剧情存档/`。
- 换世界：复制 `worlds/*.json` 改成自己的数据放进 `worlds/` 目录即可被加载；`default: true` 的是新会话默认世界，`world_init` 传 `worldId` 选择。

## 边界

- 引擎负责「世界状态」，不负责「写得好不好看」；叙述质量仍取决于角色卡、预设与模型。
- 自由场景（`locationName`）只记录地点名与时间；该地点的设施、人物与空间关系靠主持人叙述，引擎不校验。
- 外部存档是纯 Markdown 文件，内容质量取决于写记要的模型；代码只保证“写进去就不会丢”。
- NPC 决策是确定性的意图生成（目标 + 日程 + 变量 + 刺激关键词），不是独立 LLM Agent。
- 触发器与暗线只作为数据驱动的事件/机会；引擎不会替主持人写对白。
- 当前世界的时间不处理夏令时；以世界内本地时间按分钟推进。
