/**
 * ElecKoi World Engine —— DSH Host 插件入口（无外部 import 版）。
 *
 * 为什么不用 `import { defineTool } from '@deepseek-ai/dsh-tools'`：
 * 插件可能被安装/链接在任何目录，裸包名解析可能落到错误的副本或被本地
 * node_modules 遮蔽；直接交给 ctx.tools.register 原生 JSON Schema 定义，
 * 就不依赖任何 DSH 包解析，跨 DSH 0.2.2-rc.3 / rc.5 都稳定。
 *
 * 注册 9 个模型可见工具，把「世界状态机」接到角色扮演流程里：
 *   world_state / world_init / world_tick / world_move / world_npc /
 *   world_npc_act / world_apply / world_dice / world_plots
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyChanges,
  createState,
  hydrateState,
  initWorld,
  moveReport,
  npcAct,
  npcReport,
  plotsReport,
  rollDice,
  stateReport,
  tick,
  tickReport,
  playerPlace,
  clockOf,
} from './engine.js';

export const name = 'eleckoi-world-engine';
export const inject = ['tools'];

// ---------------------------------------------------------------------------
// 世界数据：worlds/*.json 全部加载，按 id 选择；world_init 的 worldId 参数切换。
// ---------------------------------------------------------------------------
const WORLDS_DIR = fileURLToPath(new URL('./worlds/', import.meta.url));
const WORLDS = new Map();
for (const file of fs.readdirSync(WORLDS_DIR)) {
  if (!file.endsWith('.json')) continue;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(WORLDS_DIR, file), 'utf8'));
    if (data && typeof data.id === 'string' && data.id) WORLDS.set(data.id, data);
    else console.warn('[world-engine] 世界数据缺少 id，已跳过：', file);
  } catch (error) {
    console.warn('[world-engine] 世界数据读取失败，已跳过：', file, error.message);
  }
}
const DEFAULT_WORLD = [...WORLDS.values()].find((item) => item.default === true) || [...WORLDS.values()][0];
if (!DEFAULT_WORLD) throw new Error('世界引擎没有可用的世界数据文件（worlds/*.json）');
const WORLD_IDS = [...WORLDS.keys()];

function worldOf(state) {
  return WORLDS.get(state && state.worldId) || DEFAULT_WORLD;
}

function worldListText() {
  return WORLD_IDS.map((id) => `${id}（${WORLDS.get(id).title || id}）`).join('、');
}

const DATA_DIR = process.env.DSH_PROFILE_DIR
  ? path.join(process.env.DSH_PROFILE_DIR, 'world-engine')
  : path.join(os.homedir(), '.dsh', 'world-engine');

// 外部剧情存档：Windows 默认写 E 盘；Android 默认写 DSH 应用私有 profile 目录。
// 可用环境变量 WORLD_ENGINE_MEMORY_DIR 或插件 config.memoryDir 覆盖。
// 注意：这里不会静默把 Windows 存档写到 C 盘；不可写时会直接报错并给出路径。
const PROFILE_HOME = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh');
const DEFAULT_MEMORY_DIR = process.platform === 'win32'
  ? 'E:\\DS Work Space\\1\\ElecKoi-德意志帝国-总集版\\剧情存档'
  : path.join(PROFILE_HOME, 'world-engine', '剧情存档');
let MEMORY_DIR = process.env.WORLD_ENGINE_MEMORY_DIR
  ? path.resolve(process.env.WORLD_ENGINE_MEMORY_DIR)
  : DEFAULT_MEMORY_DIR;

function memoryDir() {
  return MEMORY_DIR;
}

function memoryFileFor(sessionId) {
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown-session';
  return path.join(memoryDir(), `${safe}.memory.md`);
}

function ensureMemoryDir() {
  try {
    fs.mkdirSync(memoryDir(), { recursive: true });
  } catch (error) {
    throw new Error(`无法创建剧情存档目录：${memoryDir()}（${error.message}）。请确认 E 盘可写，或设置环境变量 WORLD_ENGINE_MEMORY_DIR 指向可写目录。`);
  }
}

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'default';
}

function stateFile(sessionId) {
  return path.join(DATA_DIR, `${safeId(sessionId)}.json`);
}

function sessionIdOf(exec) {
  const id = exec && exec.agent && exec.agent.session && exec.agent.session.id;
  if (!id) throw new Error('世界引擎只能在一个角色会话里使用（缺少会话编号）');
  return id;
}

function loadState(sessionId) {
  const file = stateFile(sessionId);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const world = WORLDS.get(raw.worldId) || DEFAULT_WORLD;
    return hydrateState(world, raw);
  } catch {
    return createState(DEFAULT_WORLD);
  }
}

function saveState(sessionId, state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = stateFile(sessionId);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

// ---------------------------------------------------------------------------
// 工具定义（原生 JSON Schema；ctx.tools.register 直接接受）
// ---------------------------------------------------------------------------
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

const NO_PARAMS = { type: 'object', additionalProperties: false, properties: {} };

const ok = (text) => ({ text });

function register(ctx) {
  ctx.tools.register({
    name: 'world_state',
    description: '读取当前世界的权威状态：日期/时间/地点/在场人物及其活动、可去地点、世界变量、暗线进度，以及可直接放进状态块的状态行。每轮开始先调用它；如果返回“未初始化”提示，先调用 world_init。',
    parameters: NO_PARAMS,
    output: TEXT_OUTPUT,
    execute(_args, exec) {
      const sessionId = sessionIdOf(exec);
      const state = loadState(sessionId);
      const world = worldOf(state);
      return ok(stateReport(world, state, {
        hint: state.tickCount === 0
          ? `这是开局状态；世界数据：${state.worldId}。可用世界：${worldListText()}。`
          : '',
      }));
    },
  });

  ctx.tools.register({
    name: 'world_init',
    description: '初始化/重置世界引擎：把世界时间设回开局（2025-11-21 18:30），应用开局人物站位，清空触发器与暗线进度。只在第一次开局或明确重开时调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reset: { type: 'boolean', description: 'true 表示强制重置到开局；省略时若已有状态则只读取并报告。' },
        playerName: { type: 'string', description: '主角名字，默认用世界数据里的默认主角。例：威尔海姆、维什戴尔、夏洛特。' },
        location: { type: 'string', description: '主角起始地点 id，例如 charlottenburg-palace、vienna-schonbrunn；默认用世界默认起始点。' },
        locationName: { type: 'string', description: '引擎地图之外的自由场景名（任意城市/房间），例如“伦敦·白金汉宫”。传了就按自由场景开局，不必再传 location。' },
        worldId: { type: 'string', description: '世界数据 id；总集版为 deutsches-reich-canon，旧版为 deutsches-reich。省略时沿用当前世界或默认世界。' },
        startTime: { type: 'string', description: '可选：世界起始时刻，格式 YYYY-MM-DDTHH:MM。例如情报局开场用 2025-11-22T09:00；省略时用世界数据里的默认开局时间。' },
      },
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      const existing = loadState(sessionId);
      const requestedId = args.worldId ? String(args.worldId) : '';
      let targetWorld = requestedId ? WORLDS.get(requestedId) : worldOf(existing);
      if (!targetWorld) {
        throw new Error(`没有这个世界数据：${requestedId}；可用：${worldListText()}`);
      }
      const switching = targetWorld.id !== existing.worldId && existing.tickCount > 0;
      if (switching && args.reset !== true) {
        throw new Error(`从 ${existing.worldId} 切换到 ${targetWorld.id} 需要传 reset=true（会清空该会话的世界推进状态）`);
      }
      if (!args.reset && !requestedId && existing.tickCount > 0) {
        return ok(stateReport(worldOf(existing), existing, { hint: '世界已经初始化过；如需重开请传 reset=true。' }));
      }
      const result = initWorld(targetWorld, {
        reset: args.reset === true,
        ...(args.playerName ? { playerName: args.playerName } : {}),
        ...(args.location ? { location: args.location } : {}),
        ...(args.locationName ? { locationName: args.locationName } : {}),
        ...(args.startTime ? { startTime: args.startTime } : {}),
      });
      saveState(sessionId, result.state);
      return ok(result.report);
    },
  });

  ctx.tools.register({
    name: 'world_tick',
    description: '推进世界时间（分钟），引擎会处理：NPC 日程移动、到点触发器、变量阈值触发器、暗线推进与城中传闻。返回“玩家可见事件”和“场外事件”。玩家等待、赶路、闲聊、忙碌或时间自然流逝时都必须调用它，不要自行跳时间。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        minutes: { type: 'integer', description: '推进分钟数，1–720。常规对话 5–20 分钟；等待/赶路/睡一觉按剧情取 30–480。' },
      },
      required: ['minutes'],
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      const state = loadState(sessionId);
      const world = worldOf(state);
      const result = tick(world, state, args.minutes);
      saveState(sessionId, state);
      return ok(tickReport(world, state, result));
    },
  });

  ctx.tools.register({
    name: 'world_move',
    description: '把主角移动到另一个地点：可以走到相邻的已知地点（校验出口并扣路上时间），也可以移动到引擎地图之外的自由场景（传 locationName，例如“伦敦·白厅”），或从自由场景按 minutes 回到已知地点。移动会沿途推进世界（可能触发事件），返回描述、在场人物、可见事件与新的状态行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        locationId: { type: 'string', description: '目标地点 id（引擎地图内），例如 berlin-stadtschloss、vienna-schonbrunn。从自由场景回到已知地点时可不填 minutes，默认按 180 分钟。' },
        locationName: { type: 'string', description: '自由场景名（引擎地图之外），例如“伦敦·白金汉宫”“巴黎·一家小旅馆”。传了就切换到该自由场景。' },
        minutes: { type: 'integer', description: '可选：本次路程分钟数（1–720）。自由场景之间/从自由场景回到已知地点时使用；在已知地点走相邻出口时忽略此参数。' },
      },
      required: [],
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      const state = loadState(sessionId);
      const world = worldOf(state);
      const current = playerPlace(world, state);
      const locationName = args.locationName ? String(args.locationName).trim() : '';
      const locationId = args.locationId ? String(args.locationId).trim() : '';
      const requestedMinutes = Number.isFinite(Number(args.minutes)) ? Math.round(Number(args.minutes)) : null;
      if (!locationName && !locationId) throw new Error('world_move 需要 locationId（已知地点）或 locationName（自由场景）之一');
      if (requestedMinutes != null && (requestedMinutes < 1 || requestedMinutes > 720)) throw new Error('minutes 必须在 1–720 之间');

      // 1) 切到新的自由场景
      if (locationName) {
        const travel = tick(world, state, requestedMinutes == null ? 60 : requestedMinutes);
        state.playerLocation = 'offmap';
        state.playerLocationLabel = locationName;
        saveState(sessionId, state);
        return ok(moveReport(world, state, travel, playerPlace(world, state)));
      }

      // 2) 去已知地点
      const destination = world.locations.find((item) => item.id === locationId);
      if (!destination) {
        throw new Error(`没有这个地点：${locationId}。如果这是引擎地图之外的自由场景，请用 locationName 参数，例如 locationName="伦敦·白金汉宫"。`);
      }
      if (current.offmap) {
        const travel = tick(world, state, requestedMinutes == null ? 180 : requestedMinutes);
        state.playerLocation = destination.id;
        state.playerLocationLabel = '';
        saveState(sessionId, state);
        return ok(moveReport(world, state, travel, destination));
      }
      if (destination.id === current.id) throw new Error(`已经在 ${destination.name} 了`);
      const exit = current.exits.find((item) => item.to === destination.id);
      if (!exit) {
        throw new Error(`从 ${current.name} 不能直接去 ${destination.name}。可去：${current.exits.map((item) => `${item.id}（${item.name}）`).join('、') || '（没有出口）'}`);
      }
      const travel = tick(world, state, exit.minutes);
      state.playerLocation = destination.id;
      state.playerLocationLabel = '';
      saveState(sessionId, state);
      return ok(moveReport(world, state, travel, destination));
    },
  });

  ctx.tools.register({
    name: 'world_npc',
    description: '查询一个 NPC 的权威档案：身份、当前所在地与正在做的事、目标、关系、他知道什么、接下来的日程。玩家问“某人在哪/在做什么”，或你需要让一个 NPC 出场前，先调用它；不要凭空让 NPC 出现在不该出现的地方。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        npcId: { type: 'string', description: '人物 id，例如 charlotte、schleicher、wilhelm；不确定时先用 world_state 看在场人物，或传一个 id 让工具返回可用列表。' },
      },
      required: ['npcId'],
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      const state = loadState(sessionId);
      return ok(npcReport(worldOf(state), state, args.npcId));
    },
  });

  ctx.tools.register({
    name: 'world_npc_act',
    description: '让一个 NPC 根据自己的目标、日程、世界变量和玩家行动的刺激，做出独立决定。返回决定意图与理由，由你写成对白/动作。用于关键 NPC 的关键时刻，不要每个路人每轮都调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        npcId: { type: 'string', description: '人物 id。' },
        stimulus: { type: 'string', description: '玩家刚做/说了什么（简短；会用于关键词判断，例如“质问罗曼诺夫公投的消息”）。' },
      },
      required: ['npcId'],
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      const state = loadState(sessionId);
      return ok(npcAct(worldOf(state), state, args.npcId, args.stimulus));
    },
  });

  ctx.tools.register({
    name: 'world_apply',
    description: '修改世界变量与标记：变量按增量修改并被引擎裁剪到范围内；标记用于记录“某件事是否发生/某人是否知道”。剧情造成后果（警戒上升、证据到手、声望变化、花钱）时调用，不要只在正文里写。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        changes: {
          type: 'array',
          description: '变量增量列表，例如 [{key:"court_trust",delta:1}]。可用 key 见 world_state 的世界变量。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              key: { type: 'string' },
              delta: { type: 'number' },
            },
            required: ['key', 'delta'],
          },
        },
        flags: {
          type: 'array',
          description: '要设置/取消的标记列表：写 "knows_romanov_file" 表示设置，写 "-knows_romanov_file" 表示取消。',
          items: { type: 'string' },
        },
        reason: { type: 'string', description: '一句话说明因果，例如“在晚宴上公开顶撞宰相”。' },
      },
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      const state = loadState(sessionId);
      const report = applyChanges(worldOf(state), state, args.changes, args.flags, args.reason);
      saveState(sessionId, state);
      return ok(report);
    },
  });

  ctx.tools.register({
    name: 'world_dice',
    description: '按世界规则掷一次检定（1d20 + 调整值 − 难度），返回掷骰、结果档位与叙事提示。结果不确定且失败有代价的行动（潜行、说服、战斗、意志）必须先掷骰，不要自己决定成败。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        check: { type: 'string', enum: ['skill-check', 'combat-check', 'social-check', 'resolve-check'], description: '检定类型：skill-check 技能／combat-check 战斗／social-check 社交／resolve-check 意志。' },
        modifier: { type: 'integer', description: '调整值 −5 到 +5（能力、准备、关系加成等），默认 0。' },
        dc: { type: 'integer', description: '难度，默认 10；普通 10、困难 14、极难 18。' },
      },
      required: ['check'],
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      const state = loadState(sessionId);
      return ok(rollDice(worldOf(state), state, args.check, args.modifier ?? 0, args.dc));
    },
  });

  ctx.tools.register({
    name: 'world_plots',
    description: '查看三条暗线的进度、前提与最近推进。每轮不必调用；在玩家接近相关人物/地点，或你想判断“世界该不该有动静”时查看。暗线只作为机会，不强迫玩家跟随。',
    parameters: NO_PARAMS,
    output: TEXT_OUTPUT,
    execute(_args, exec) {
      const sessionId = sessionIdOf(exec);
      const state = loadState(sessionId);
      return ok(plotsReport(worldOf(state), state));
    },
  });

  ctx.tools.register({
    name: 'world_memory',
    description: '外部剧情存档（写到 E 盘的 Markdown 文件）：把关键剧情记要追加保存，或读取/列出已有存档。每 8–12 轮或章节收束时用 save；玩家说“读取存档/回顾一下”时用 read。存档不占上下文、不会因为对话变长而消失。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['save', 'read', 'list'], description: 'save=追加一条记要；read=读取当前会话存档；list=列出全部存档文件。' },
        text: { type: 'string', description: 'save 时必填：3–5 行关键事件、关系变化、未结线索。' },
        chapter: { type: 'string', description: 'save 时可选：章节/场景标题，例如“第 3 章 · 柏林雨夜”。' },
        limit: { type: 'integer', description: 'read 时可选：只返回最近 N 条记要（默认全部）。' },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const action = String(args.action || '').trim();
      if (action === 'list') {
        ensureMemoryDir();
        const dir = memoryDir();
        const files = fs.readdirSync(dir)
          .filter((name) => name.endsWith('.memory.md'))
          .map((name) => {
            const full = path.join(dir, name);
            const stat = fs.statSync(full);
            return { name, bytes: stat.size, modified: stat.mtime.toISOString() };
          })
          .sort((left, right) => right.modified.localeCompare(left.modified));
        const text = files.length
          ? files.map((file) => `  - ${file.name}（${file.bytes} 字节，${file.modified}）`).join('\n')
          : '  （还没有存档）';
        return ok([
          `【剧情存档】目录：${dir}`,
          text,
          '',
          '读取：让模型调用 world_memory { action:"read" }，或直接打开上面目录里的 .memory.md 文件。',
        ].join('\n'));
      }

      const sessionId = sessionIdOf(exec);
      const file = memoryFileFor(sessionId);

      if (action === 'read') {
        if (!fs.existsSync(file)) {
          throw new Error(`还没有当前会话的剧情存档：${file}。先跑一段剧情，让模型调用 world_memory { action:"save" }，或直接说“保存存档”。`);
        }
        let content = fs.readFileSync(file, 'utf8');
        const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.round(Number(args.limit)) : null;
        if (limit) {
          const chunks = content.split(/\n(?=## )/);
          const header = chunks.shift() || '';
          content = [header, ...chunks.slice(-limit)].join('\n');
        }
        return ok([`【剧情存档】${file}`, '', content].join('\n'));
      }

      if (action === 'save') {
        const text = String(args.text || '').trim();
        if (!text) throw new Error('world_memory save 需要 text（3–5 行关键事件、关系变化与未结线索）');
        const state = loadState(sessionId);
        const world = worldOf(state);
        const clock = clockOf(world, state.absMinutes);
        ensureMemoryDir();
        const existed = fs.existsSync(file);
        if (!existed) {
          const header = [
            `# 剧情存档 · ${world.title}`,
            '',
            `- 世界：${world.id}`,
            `- 会话：${sessionId}`,
            `- 存档目录：${memoryDir()}`,
            `- 创建：${new Date().toISOString()}`,
            '',
          ].join('\n');
          fs.writeFileSync(file, header, 'utf8');
        }
        const chapter = args.chapter ? String(args.chapter).trim() : '';
        const record = [
          `## ${clock.dateText} ${clock.timeText}${chapter ? ` · ${chapter}` : ''}`,
          '',
          text,
          '',
        ].join('\n');
        fs.appendFileSync(file, `${record}\n`, 'utf8');
        const content = fs.readFileSync(file, 'utf8');
        const count = (content.match(/^## /gm) || []).length;
        return ok([
          `【剧情存档】已保存到：${file}`,
          `当前共 ${count} 条；世界时间 ${clock.dateText} ${clock.timeText}${chapter ? `；${chapter}` : ''}`,
          '',
          '读取：world_memory { action:"read" }，或直接打开上面的 .memory.md 文件。',
        ].join('\n'));
      }

      throw new Error(`未知 action：${action}；可用：save / read / list`);
    },
  });
}

export function apply(ctx, config = {}) {
  if (config && typeof config.memoryDir === 'string' && config.memoryDir.trim()) {
    MEMORY_DIR = path.resolve(config.memoryDir.trim());
  }
  register(ctx);
  return () => {};
}
