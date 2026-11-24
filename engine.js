/**
 * ElecKoi World Engine —— 纯逻辑世界模拟器。
 *
 * 设计目标：把「真沙盒」里最容易被 LLM 弄丢的部分交给代码判定：
 *   - 世界时间（分钟级推进）
 *   - NPC 日程（每个 NPC 什么时候在哪、在做什么）
 *   - 触发器（到点必然发生 / 变量到阈值必然发生）
 *   - 暗线节奏（按 tick 推进阶段，产出只作为机会/伏笔）
 *   - 世界变量（范围裁剪、档位标签）
 *   - 骰子检定（1d20 + 调整 - 难度 → 档位）
 *   - NPC 自主决策（目标优先级 + 日程 + 刺激关键词 → 决定意图）
 *
 * 这个文件不依赖 DSH，可单独测试；index.js 只负责把它注册成 DSH 工具。
 */

export const ENGINE_VERSION = 1;
export const MINUTES_PER_DAY = 24 * 60;
const MAX_LOG = 60;

// ---------------------------------------------------------------------------
// 时间
// ---------------------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, '0');

export function parseAbsolute(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) throw new Error(`时间格式必须是 YYYY-MM-DDTHH:MM，收到：${value}`);
  return { date: `${m[1]}-${m[2]}-${m[3]}`, hour: Number(m[4]), minute: Number(m[5]) };
}

export function dayNumber(dateText) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText));
  if (!m) throw new Error(`日期格式必须是 YYYY-MM-DD，收到：${dateText}`);
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}

export function dateFromDayNumber(day) {
  const d = new Date(day * 86400000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 世界日期 + 绝对分钟 → {day, minuteOfDay, dateText, timeText} */
export function clockOf(world, absMinutes) {
  const baseDay = dayNumber(world.worldDate);
  const day = baseDay + Math.floor(absMinutes / MINUTES_PER_DAY);
  const minuteOfDay = ((absMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const date = dateFromDayNumber(day);
  return {
    day,
    minuteOfDay,
    hour,
    minute,
    date,
    dateText: `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`,
    timeText: `${pad2(hour)}:${pad2(minute)}`,
    absolute: `${date}T${pad2(hour)}:${pad2(minute)}`,
  };
}

export function absFromDateTime(world, value) {
  const parsed = parseAbsolute(value);
  return (dayNumber(parsed.date) - dayNumber(world.worldDate)) * MINUTES_PER_DAY + parsed.hour * 60 + parsed.minute;
}

export function nowText(world, state) {
  const clock = clockOf(world, state.absMinutes);
  return `${clock.dateText} ${clock.timeText}`;
}

// ---------------------------------------------------------------------------
// 变量
// ---------------------------------------------------------------------------
function variableDef(world, key) {
  return world.variables.find((item) => item.key === key);
}

function clampVariable(def, value) {
  let next = Number(value);
  if (!Number.isFinite(next)) return def.default;
  if (def.integer) next = Math.round(next);
  return Math.min(def.max, Math.max(def.min, next));
}

export function bandLabelOf(def, value) {
  if (!def.bands || def.bands.length === 0) return String(value);
  for (const band of def.bands) {
    if (value <= band.upTo) return `${band.label}（${value}/${def.max}）`;
  }
  return `${def.max}/${def.max}`;
}

function defaultVariables(world) {
  const out = {};
  for (const def of world.variables) out[def.key] = def.default;
  return out;
}

// ---------------------------------------------------------------------------
// NPC 位置 / 日程
// ---------------------------------------------------------------------------
function scheduleBlockAt(npc, minuteOfDay) {
  const blocks = npc.schedule || [];
  for (const block of blocks) {
    if (minuteOfDay >= block.from && minuteOfDay < block.to) return block;
  }
  return null;
}

export function npcPlacementAt(world, state, npc, absMinutes) {
  const override = state.npcOverride[npc.id];
  if (override && (override.until == null || absMinutes < override.until)) {
    return { locationId: override.location, activity: override.activity || '在场', source: 'event' };
  }
  const clock = clockOf(world, absMinutes);
  const block = scheduleBlockAt(npc, clock.minuteOfDay);
  if (block) return { locationId: block.location, activity: block.activity, source: 'schedule' };
  return { locationId: npc.home, activity: '休息', source: 'schedule' };
}

export function locationById(world, id) {
  const location = world.locations.find((item) => item.id === id);
  if (!location) throw new Error(`没有这个地点：${id}`);
  return location;
}

/** 玩家的当前位置：已知地点，或引擎之外的自由场景（离图）。 */
export function playerPlace(world, state) {
  if (state.playerLocation === 'offmap') {
    return {
      id: 'offmap',
      name: state.playerLocationLabel || '别处（自由场景）',
      description: '这是引擎地图之外的自由场景：时间、变量与 NPC 日程仍然照常运转，但这里没有固定出口与预设设施，地点由主持人按叙述维护。',
      features: [],
      exits: [],
      offmap: true,
    };
  }
  const location = world.locations.find((item) => item.id === state.playerLocation);
  if (location) return location;
  // 兼容旧状态或手工写入的无效地点
  return {
    id: state.playerLocation || 'offmap',
    name: state.playerLocationLabel || String(state.playerLocation || '别处（自由场景）'),
    description: '（未收录在引擎地图中的地点）',
    features: [],
    exits: [],
    offmap: true,
  };
}

/** 当前玩家扮演的角色如果也是 NPC 档案之一，就不应再作为“在场 NPC”出现。 */
export function isPlayerNpc(state, npc) {
  const name = String(state.playerName || '').trim();
  if (!name) return false;
  if (npc.name === name || npc.name.startsWith(name)) return true;
  return Array.isArray(npc.aliases) && npc.aliases.includes(name);
}

export function npcsAt(world, state, locationId, absMinutes = state.absMinutes) {
  const out = [];
  for (const npc of world.npcs) {
    if (isPlayerNpc(state, npc)) continue;
    const placement = npcPlacementAt(world, state, npc, absMinutes);
    if (placement.locationId === locationId) out.push({ npc, ...placement });
  }
  return out;
}

function hereNames(world, state, absMinutes = state.absMinutes) {
  const here = npcsAt(world, state, state.playerLocation, absMinutes);
  return here.length ? here.map((item) => item.npc.name).join('、') : '（无人在场）';
}

function describeHere(world, state) {
  const here = npcsAt(world, state, state.playerLocation);
  if (!here.length) return '  （没有别人）';
  return here.map((item) => `  - ${item.npc.name}：${item.activity}${item.source === 'event' ? '（事件安排）' : ''}`).join('\n');
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
export function createState(world, options = {}) {
  const startAbs = options.startTime ? absFromDateTime(world, options.startTime) : absFromDateTime(world, world.startTime);
  const placementHold = Number.isFinite(Number(options.startPlacementMinutes)) ? Number(options.startPlacementMinutes) : 180;
  const customName = options.locationName ? String(options.locationName).trim() : '';
  let playerLocation = customName ? 'offmap' : (options.location || world.player.startLocation);
  let playerLocationLabel = customName;
  if (!customName && !world.locations.some((item) => item.id === playerLocation)) {
    throw new Error(`没有这个地点：${playerLocation}。如果想在引擎地图之外开局，请传 locationName（自由场景名），例如 locationName="伦敦·白金汉宫"。`);
  }
  const state = {
    worldId: world.id,
    engineVersion: ENGINE_VERSION,
    absMinutes: startAbs,
    playerName: options.playerName || world.player.name,
    playerLocation,
    playerLocationLabel,
    npcOverride: {},
    firedTriggers: {},
    variables: defaultVariables(world),
    flags: {},
    plotStage: {},
    lastPlotTick: {},
    tickCount: 0,
    log: [],
    rumorIndex: 0,
  };
  for (const plot of world.plots) {
    state.plotStage[plot.id] = 0;
    state.lastPlotTick[plot.id] = 0;
  }
  for (const [npcId, placement] of Object.entries(world.startPlacements || {})) {
    state.npcOverride[npcId] = { location: placement.location, activity: placement.activity, until: startAbs + placementHold };
  }
  return state;
}

export function hydrateState(world, raw) {
  if (!raw || typeof raw !== 'object') return createState(world);
  if (raw.worldId !== world.id || raw.engineVersion !== ENGINE_VERSION) return createState(world);
  const base = createState(world);
  const state = {
    ...base,
    ...raw,
    variables: { ...base.variables, ...(raw.variables || {}) },
    flags: { ...(raw.flags || {}) },
    npcOverride: { ...(raw.npcOverride || {}) },
    firedTriggers: { ...(raw.firedTriggers || {}) },
    plotStage: { ...base.plotStage, ...(raw.plotStage || {}) },
    lastPlotTick: { ...base.lastPlotTick, ...(raw.lastPlotTick || {}) },
    log: Array.isArray(raw.log) ? raw.log.slice(-MAX_LOG) : [],
  };
  for (const def of world.variables) {
    state.variables[def.key] = clampVariable(def, state.variables[def.key]);
  }
  if (!world.locations.some((item) => item.id === state.playerLocation) && state.playerLocation !== 'offmap') {
    state.playerLocation = world.player.startLocation;
    state.playerLocationLabel = '';
  }
  return state;
}

function addLog(state, text, at, scope) {
  state.log.push({ at, scope, text });
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

// ---------------------------------------------------------------------------
// 触发
// ---------------------------------------------------------------------------
function triggerVisible(world, state, trigger) {
  const visibility = trigger.visibility || 'offscreen';
  if (visibility === 'public') return true;
  if (visibility.startsWith('location:')) return visibility.slice('location:'.length) === state.playerLocation;
  if (visibility.startsWith('npc:')) {
    const npcId = visibility.slice('npc:'.length);
    return npcsAt(world, state, state.playerLocation).some((item) => item.npc.id === npcId);
  }
  return false;
}

function applyTriggerEffects(world, state, trigger, absMinutes) {
  const effects = trigger.effects || {};
  const applied = [];
  if (effects.variables) {
    for (const [key, delta] of Object.entries(effects.variables)) {
      const def = variableDef(world, key);
      if (!def) continue;
      const before = state.variables[key];
      const next = clampVariable(def, before + Number(delta));
      state.variables[key] = next;
      if (next !== before) applied.push(`${def.name} ${before} → ${next}`);
    }
  }
  if (effects.place) {
    for (const [npcId, pair] of Object.entries(effects.place)) {
      const npc = world.npcs.find((item) => item.id === npcId);
      if (!npc) continue;
      const [location, activity] = pair;
      state.npcOverride[npcId] = { location, activity, until: absMinutes + 6 * 60 };
      applied.push(`${npc.name} 出现在${(world.locations.find((item) => item.id === location) || {}).name || location}`);
    }
  }
  return applied;
}

function fireTrigger(world, state, trigger, absMinutes, visible, offscreen) {
  const applied = applyTriggerEffects(world, state, trigger, absMinutes);
  state.firedTriggers[trigger.id] = absMinutes;
  const scope = triggerVisible(world, state, trigger) ? 'visible' : 'offscreen';
  const detail = applied.length ? `（${applied.join('；')}）` : '';
  const entry = `【${clockOf(world, absMinutes).timeText}】${trigger.title}：${trigger.text}${detail}`;
  (scope === 'visible' ? visible : offscreen).push(entry);
  addLog(state, entry, absMinutes, scope);
  return scope;
}

function variableConditionMet(world, state, condition) {
  const def = variableDef(world, condition.variable);
  if (!def) return false;
  const value = state.variables[condition.variable];
  switch (condition.op) {
    case 'gte': return value >= condition.value;
    case 'gt': return value > condition.value;
    case 'lte': return value <= condition.value;
    case 'lt': return value < condition.value;
    case 'eq': return value === condition.value;
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// 推进
// ---------------------------------------------------------------------------
export function tick(world, state, minutes) {
  const amount = Math.trunc(Number(minutes));
  if (!Number.isFinite(amount) || amount < 1) throw new Error('推进分钟数必须是正整数');
  if (amount > 720) throw new Error('一次最多推进 720 分钟（12 小时）；更长的跨度请分多次');
  const t0 = state.absMinutes;
  const t1 = t0 + amount;
  const visible = [];
  const offscreen = [];

  // 1. 时间触发器（在 (t0, t1] 内到点）
  const timeTriggers = world.triggers
    .filter((item) => item.at)
    .map((item) => ({ trigger: item, at: absFromDateTime(world, item.at) }))
    .filter((item) => !state.firedTriggers[item.trigger.id] && item.at > t0 && item.at <= t1)
    .sort((left, right) => left.at - right.at);
  const beforeLocations = new Map();
  for (const npc of world.npcs) beforeLocations.set(npc.id, npcPlacementAt(world, state, npc, t0).locationId);
  for (const item of timeTriggers) fireTrigger(world, state, item.trigger, item.at, visible, offscreen);

  // 2. 推进时间
  state.absMinutes = t1;
  state.tickCount += 1;

  // 3. 变量触发器（当前时刻满足阈值）
  for (const trigger of world.triggers.filter((item) => item.when)) {
    if (state.firedTriggers[trigger.id]) continue;
    if (variableConditionMet(world, state, trigger.when)) {
      fireTrigger(world, state, trigger, t1, visible, offscreen);
    }
  }

  // 4. NPC 进出玩家所在地点
  const playerLocation = state.playerLocation;
  for (const npc of world.npcs) {
    const before = beforeLocations.get(npc.id);
    const after = npcPlacementAt(world, state, npc, t1);
    if (before !== playerLocation && after.locationId === playerLocation) {
      visible.push(`【${clockOf(world, t1).timeText}】${npc.name}来到这里：${after.activity}`);
    } else if (before === playerLocation && after.locationId !== playerLocation) {
      visible.push(`【${clockOf(world, t1).timeText}】${npc.name}离开了这里：${after.activity}`);
    }
  }

  // 5. 暗线按 tick 推进（只产出机会/伏笔，不强迫玩家）
  for (const plot of world.plots) {
    const stage = state.plotStage[plot.id] || 0;
    const last = state.lastPlotTick[plot.id] || 0;
    if (stage >= plot.steps.length) continue;
    if (state.tickCount - last < plot.intervalTicks) continue;
    const step = plot.steps[stage];
    state.plotStage[plot.id] = stage + 1;
    state.lastPlotTick[plot.id] = state.tickCount;
    const text = `【暗线·${plot.name}】${step.text}`;
    offscreen.push(text);
    addLog(state, text, t1, 'offscreen');
  }

  // 6. 环境传闻（没有可见事件时补充世界质感）
  if (visible.length === 0 && state.tickCount % 3 === 0) {
    const rumor = world.rumors[state.rumorIndex % world.rumors.length];
    state.rumorIndex += 1;
    const text = `【城中传闻】${rumor}`;
    offscreen.push(text);
    addLog(state, text, t1, 'offscreen');
  }

  // 7. 清理过期事件覆盖
  for (const [npcId, placement] of Object.entries(state.npcOverride)) {
    if (placement.until != null && t1 >= placement.until) delete state.npcOverride[npcId];
  }

  state.lastTickFrom = t0;
  state.lastTickTo = t1;
  return { visible, offscreen, from: t0, to: t1 };
}

// ---------------------------------------------------------------------------
// 报告文本
// ---------------------------------------------------------------------------
export function statusLines(world, state) {
  const clock = clockOf(world, state.absMinutes);
  const place = playerPlace(world, state);
  return [
    `日期：${clock.dateText}`,
    `时间：${clock.timeText}`,
    `地点：${place.name}`,
    `在场：${hereNames(world, state)}`,
    `视角：${state.playerName}`,
  ];
}

function exitsText(world, state) {
  const place = playerPlace(world, state);
  if (place.offmap) {
    return '  （自由场景没有固定出口：可用 world_move 传 locationName 切换到另一个自由场景，或传 locationId + minutes 回到引擎地图中的已知地点）';
  }
  if (!place.exits.length) return '  （没有已知出口）';
  return place.exits
    .map((exit) => `  - ${exit.name}（${exit.id}，约 ${exit.minutes} 分钟）${exit.via ? `：${exit.via}` : ''}`)
    .join('\n');
}

function variablesText(world, state) {
  return world.variables
    .map((def) => {
      const value = state.variables[def.key];
      const hidden = def.visibility === 'hidden' ? '（隐藏，仅主持人可见）' : '';
      return `  - ${def.name} ${bandLabelOf(def, value)}${hidden}`;
    })
    .join('\n');
}

function plotsText(world, state) {
  return world.plots
    .map((plot) => {
      const stage = state.plotStage[plot.id] || 0;
      const last = plot.steps[stage - 1];
      const progress = stage >= plot.steps.length ? '已走完' : `${stage}/${plot.steps.length}`;
      return `  - ${plot.name}（${plot.id}）：${progress}${last ? `；最近推进：${last.text}` : ''}`;
    })
    .join('\n');
}

export function stateReport(world, state, extra = {}) {
  const clock = clockOf(world, state.absMinutes);
  const place = playerPlace(world, state);
  const lines = [
    `【世界状态】${world.title}`,
    `时间：${clock.dateText} ${clock.timeText}（${clock.absolute}）`,
    `地点：${place.name}（${place.offmap ? '自由场景，引擎地图之外' : place.id}）`,
    `主角：${state.playerName}；已推进 ${state.tickCount} 个时间片`,
    '',
    '在场：',
    describeHere(world, state),
    '',
    '可去：',
    exitsText(world, state),
    '',
    '世界变量：',
    variablesText(world, state),
    '',
    '暗线：',
    plotsText(world, state),
    '',
    '状态行（原样放进状态块）：',
    ...statusLines(world, state).map((line) => `  ${line}`),
  ];
  if (extra.hint) lines.push('', `提示：${extra.hint}`);
  return lines.join('\n');
}

export function tickReport(world, state, result) {
  const clock = clockOf(world, result.to);
  const lines = [
    `【时间推进】+${result.to - result.from} 分钟 → ${clock.dateText} ${clock.timeText}`,
    '',
    '玩家可见事件：',
    result.visible.length ? result.visible.map((line) => `  - ${line}`).join('\n') : '  （没有）',
    '',
    '场外事件（玩家不在场；只能通过他人转述、新闻或伏笔使用，不能直接叙述成玩家目睹）：',
    result.offscreen.length ? result.offscreen.map((line) => `  - ${line}`).join('\n') : '  （没有）',
    '',
    '当前状态：',
    ...statusLines(world, state).map((line) => `  ${line}`),
  ];
  return lines.join('\n');
}

export function moveReport(world, state, travelResult, destination) {
  const clock = clockOf(world, state.absMinutes);
  const here = npcsAt(world, state, destination.id);
  const lines = [
    `【移动】你到达 ${destination.name}${destination.offmap ? '（自由场景）' : `（${destination.id}）`}，路程 ${travelResult.to - travelResult.from} 分钟；现在是 ${clock.dateText} ${clock.timeText}`,
    '',
    destination.description,
    destination.features.length ? `可看之处：${destination.features.map((f) => f.name).join('、')}` : '',
    '',
    '在场：',
    here.length
      ? here.map((item) => `  - ${item.npc.name}：${item.activity}`).join('\n')
      : '  （没有别人）',
    '',
    '可见事件：',
    travelResult.visible.length ? travelResult.visible.map((line) => `  - ${line}`).join('\n') : '  （路上没有特别的事）',
    '',
    '从这里可以去：',
    exitsText(world, state),
    '',
    '状态行（原样放进状态块）：',
    ...statusLines(world, state).map((line) => `  ${line}`),
  ];
  return lines.filter((line) => line !== null).join('\n');
}

export function npcReport(world, state, npcId) {
  const npc = world.npcs.find((item) => item.id === npcId);
  if (!npc) throw new Error(`没有这个人物：${npcId}；可用：${world.npcs.map((item) => item.id).join(', ')}`);
  if (isPlayerNpc(state, npc)) throw new Error(`${npc.name} 是当前玩家角色，不能作为 NPC 查询；请改用世界状态/状态块描述玩家自己。`);
  const placement = npcPlacementAt(world, state, npc, state.absMinutes);
  const location = world.locations.find((item) => item.id === placement.locationId);
  const clock = clockOf(world, state.absMinutes);
  const schedule = npc.schedule
    .filter((block) => block.to > clock.minuteOfDay)
    .slice(0, 4)
    .map((block) => `  - ${pad2(Math.floor(block.from / 60))}:${pad2(block.from % 60)}-${pad2(Math.floor(block.to / 60))}:${pad2(block.to % 60)} ${block.location}：${block.activity}`)
    .join('\n');
  return [
    `【人物】${npc.name}`,
    `身份：${npc.title || npc.summary}`,
    `现在：${(location || {}).name || placement.locationId} —— ${placement.activity}`,
    '',
    npc.personality ? `性格：${npc.personality}` : '',
    npc.speech && npc.speech.style ? `说话方式：${npc.speech.style}` : '',
    '',
    '目标：',
    npc.goals.map((goal) => `  - ${goal.name}（优先级 ${goal.priority}）`).join('\n') || '  （没有明确目标）',
    '',
    '关系：',
    npc.relationships.map((rel) => `  - ${rel.name}（${rel.label}）：${rel.summary}`).join('\n') || '  （没有记录）',
    '',
    '知道：',
    npc.knowledge.map((item) => `  - ${item}`).join('\n') || '  （没有特别记录）',
    '',
    '接下来的日程：',
    schedule || '  （当前没有更多日程）',
    '',
    '注意：这个人物只知道上列信息与他在场时看到的事；不要把玩家/读者知道的事当成他知道。',
  ].filter((line) => line !== '').join('\n');
}

// ---------------------------------------------------------------------------
// NPC 自主决策
// ---------------------------------------------------------------------------
function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

export function npcAct(world, state, npcId, stimulus = '') {
  const npc = world.npcs.find((item) => item.id === npcId);
  if (!npc) throw new Error(`没有这个人物：${npcId}；可用：${world.npcs.map((item) => item.id).join(', ')}`);
  if (isPlayerNpc(state, npc)) throw new Error(`${npc.name} 是当前玩家角色，不能作为 NPC 驱动；玩家角色的行动由玩家决定。`);
  const clock = clockOf(world, state.absMinutes);
  const placement = npcPlacementAt(world, state, npc, state.absMinutes);
  const stimulusText = String(stimulus || '').trim();
  const candidates = [];

  // 目标驱动
  for (const goal of npc.goals) {
    candidates.push({
      intent: `推进目标「${goal.name}」`,
      score: Number(goal.priority || 0.5) * 10 + hashString(npc.id + goal.name + clock.absolute) * 2,
      reason: `这是${npc.name}的长期目标之一`,
    });
  }
  // 日程驱动
  if (placement.source === 'schedule') {
    candidates.push({
      intent: `按日程${placement.activity}`,
      score: 8 + hashString(npc.id + 'schedule' + clock.absolute),
      reason: '当前日程安排',
    });
  }
  // 状态变量驱动：任意非隐藏变量逼近上限时，NPC 会把它当回事
  for (const def of world.variables || []) {
    if (def.visibility === 'hidden') continue;
    const value = state.variables[def.key];
    const span = Math.max(1, def.max - def.min);
    const ratio = (value - def.min) / span;
    if (ratio >= 0.8) {
      candidates.push({ intent: `为「${def.name}」继续恶化做准备`, score: 9, reason: `${def.name}已经到${bandLabelOf(def, value)}` });
    }
  }
  // 刺激驱动（玩家行动/话语里的关键词）：从世界数据里取人名、地名、暗线名、变量名
  if (stimulusText) {
    const keywordPool = new Set();
    for (const item of world.npcs || []) {
      keywordPool.add(item.name);
      for (const alias of item.aliases || []) keywordPool.add(alias);
    }
    for (const item of world.locations || []) keywordPool.add(item.name);
    for (const item of world.plots || []) keywordPool.add(item.name);
    for (const item of world.variables || []) keywordPool.add(item.name);
    for (const keywordRaw of keywordPool) {
      const keyword = String(keywordRaw || '').trim();
      if (keyword.length < 2) continue;
      if (keyword === npc.name || (npc.aliases || []).includes(keyword)) continue;
      if (stimulusText.includes(keyword)) {
        candidates.push({ intent: `回应「${keyword}」带来的变数`, score: 10 + hashString(npc.id + keyword), reason: `玩家的行动涉及「${keyword}」` });
      }
    }
    candidates.push({ intent: '先观察对方再回应', score: 6, reason: '面对不确定的刺激，先稳住局面' });
  }
  candidates.sort((left, right) => right.score - left.score);
  const choice = candidates[0];
  const location = world.locations.find((item) => item.id === placement.locationId) || { name: placement.locationId };
  return [
    `【NPC 决策】${npc.name}（${clock.absolute}）`,
    stimulusText ? `刺激：${stimulusText}` : '刺激：（没有明确的玩家行动）',
    `决定：${choice.intent}`,
    `理由：${choice.reason}`,
    `当前所在：${location.name}（${placement.activity}）`,
    '用法：让这个决定成为 NPC 的行为动机；可以写进对白、动作或旁白，但不要替玩家角色做决定。',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 变量修改
// ---------------------------------------------------------------------------
export function applyChanges(world, state, changes, flags, reason = '') {
  if (!Array.isArray(changes) && changes !== undefined) throw new Error('changes 必须是数组');
  const applied = [];
  for (const change of changes || []) {
    const def = variableDef(world, change.key);
    if (!def) throw new Error(`没有这个变量：${change.key}；可用：${world.variables.map((item) => item.key).join(', ')}`);
    const before = state.variables[def.key];
    const next = clampVariable(def, before + Number(change.delta || 0));
    state.variables[def.key] = next;
    if (next !== before) applied.push(`${def.name}：${before} → ${next}（${bandLabelOf(def, next)}）`);
  }
  for (const flag of flags || []) {
    const name = String(flag).trim();
    if (!name) continue;
    if (name.startsWith('-')) {
      delete state.flags[name.slice(1)];
      applied.push(`取消标记：${name.slice(1)}`);
    } else {
      state.flags[name.replace(/^\+/, '')] = true;
      applied.push(`设置标记：${name.replace(/^\+/, '')}`);
    }
  }
  const clock = clockOf(world, state.absMinutes);
  addLog(state, `变量修改${reason ? `（${reason}）` : ''}：${applied.join('；') || '无变化'}`, state.absMinutes, 'system');
  return [
    `【变量修改】${clock.dateText} ${clock.timeText}${reason ? `（${reason}）` : ''}`,
    applied.length ? applied.map((line) => `  - ${line}`).join('\n') : '  （没有变化）',
    '',
    '当前变量：',
    variablesText(world, state),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 骰子
// ---------------------------------------------------------------------------
export function rollDice(world, state, checkKey, modifier = 0, dc) {
  const check = world.dice.checks.find((item) => item.key === checkKey);
  if (!check) throw new Error(`没有这个检定：${checkKey}；可用：${world.dice.checks.map((item) => item.key).join(', ')}`);
  const difficulty = Number.isFinite(Number(dc)) ? Number(dc) : world.dice.defaultDifficulty;
  const adjust = Number.isFinite(Number(modifier)) ? Number(modifier) : 0;
  const roll = 1 + Math.floor(Math.random() * 20);
  const score = roll + adjust - difficulty;
  let band = check.bands.find((item) => (item.min === undefined || score >= item.min) && (item.max === undefined || score <= item.max));
  if (!band) band = check.bands[check.bands.length - 1];
  const clock = clockOf(world, state.absMinutes);
  return [
    `【检定】${check.name}（${check.dice}）—— ${clock.dateText} ${clock.timeText}`,
    `掷骰：${roll}${adjust ? ` ${adjust >= 0 ? '+' : ''}${adjust}` : ''} − 难度 ${difficulty} = ${score}`,
    `结果：${band.label}${band.critical ? '（暴击档）' : ''}`,
    `用途：${check.use}`,
    '用法：把结果写进叙事（成功/失败/代价），不要直接报数字给玩家听；需要时可以继续用变量记录后果。',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 暗线
// ---------------------------------------------------------------------------
export function plotsReport(world, state) {
  const lines = [`【暗线】${world.title}`];
  for (const plot of world.plots) {
    const stage = state.plotStage[plot.id] || 0;
    lines.push('');
    lines.push(`${plot.name}（${plot.id}）—— 进度 ${stage}/${plot.steps.length}`);
    lines.push(`  前提：${plot.premise}`);
    const recent = plot.steps.slice(Math.max(0, stage - 2), stage);
    lines.push(recent.length ? `  最近推进：${recent.map((step) => step.text).join(' / ')}` : '  最近推进：（还没有）');
    lines.push(`  相关人物：${plot.participants.slice(0, 8).join('、')}`);
  }
  lines.push('', '用法：暗线只作为机会与伏笔；不要强迫玩家跟随，也不要让 NPC 凭空知道玩家没经历的事。');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
export function initWorld(world, options = {}) {
  const state = createState(world, options);
  const clock = clockOf(world, state.absMinutes);
  const place = playerPlace(world, state);
  const hint = options.reset
    ? `世界已重置到 ${clock.dateText} ${clock.timeText}（${clock.absolute}），地点：${place.name}${place.offmap ? '（自由场景）' : ''}。请确认开场白描述的时间/地点与状态行一致。`
    : '世界已初始化。第一轮请先用 world_state 确认状态，再按开场白开始叙述。';
  return { state, report: stateReport(world, state, { hint }) };
}

export { locationById as findLocation };
