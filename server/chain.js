// 链路：把多条已保存的用例串成有先后顺序的步骤，后一步可以按一段路径从前一步的响应里取值，
// 换进本步目标地址、请求头或请求内容里写好占位标记的位置。
// 这里负责链路的结构校验、依赖检查（指向不存在、还没执行、绕成一圈）以及按顺序真正执行。

const crypto = require('crypto');
const { ApiError, normalizeRequestDraft } = require('./api');
const target = require('./target');
const { load, save } = require('./store');

const MAX_CHAIN_NAME_LENGTH = 60;
const MAX_STEP_COUNT = 20;
const MAX_EXTRACT_COUNT = 10;
const MAX_PATH_LENGTH = 200;
const MAX_KEY_LENGTH = 40;

// 占位标记写作 {{名称}}，名称里不允许再出现花括号；名称前后允许留空格
function placeholderPattern(key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, 'g');
}

function validateChainName(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new ApiError(400, 'CHAIN_NAME_REQUIRED', '请填写链路名称', 'name');
  if (name.length > MAX_CHAIN_NAME_LENGTH) {
    throw new ApiError(400, 'CHAIN_NAME_TOO_LONG', `链路名称不能超过 ${MAX_CHAIN_NAME_LENGTH} 个字符`, 'name');
  }
  return name;
}

// 取值路径的写法：items[0].id 与 items.0.id 都接受，整理成一段一段的路径
function parseExtractPath(path) {
  const text = typeof path === 'string' ? path.trim() : '';
  if (!text) return null;
  const normalized = text
    .replace(/\[\s*(\d+)\s*\]/g, '.$1')
    .replace(/\[\s*["']([^"']+)["']\s*\]/g, '.$1');
  if (normalized.includes('[') || normalized.includes(']')) return null;
  const segments = normalized.split('.').map((segment) => segment.trim());
  if (segments.some((segment) => !segment)) return null;
  return segments;
}

// 单条注入规则：占位标记名称 + 从哪一步取 + 取值路径。
// 被跳过的步骤不会执行，规则按原样保留不逐条校验，恢复时再按完整规则检查。
function normalizeExtracts(rawList, stepIndex, relaxed) {
  if (rawList === undefined || rawList === null) return [];
  if (!Array.isArray(rawList)) {
    throw new ApiError(400, 'CHAIN_EXTRACTS_INVALID', `第 ${stepIndex + 1} 步的注入规则需要按行列表填写`, `steps.${stepIndex}.extracts`);
  }
  if (rawList.length > MAX_EXTRACT_COUNT) {
    throw new ApiError(400, 'CHAIN_EXTRACTS_TOO_MANY', `第 ${stepIndex + 1} 步的注入规则最多 ${MAX_EXTRACT_COUNT} 条`, `steps.${stepIndex}.extracts`);
  }
  const seen = new Set();
  return rawList.map((raw, ruleIndex) => {
    const source = raw && typeof raw === 'object' ? raw : {};
    const rule = {
      id: typeof source.id === 'string' && source.id ? source.id : `ex-${crypto.randomUUID()}`,
      key: typeof source.key === 'string' ? source.key.trim() : '',
      fromStep: typeof source.fromStep === 'string' ? source.fromStep : '',
      path: typeof source.path === 'string' ? source.path.trim() : '',
    };
    if (relaxed) return rule;
    const field = (part) => `steps.${stepIndex}.extracts.${ruleIndex}.${part}`;
    const where = `第 ${stepIndex + 1} 步的第 ${ruleIndex + 1} 条注入`;
    if (!rule.key) throw new ApiError(400, 'CHAIN_EXTRACT_KEY_REQUIRED', `${where}还没有填写占位标记名称`, field('key'));
    if (rule.key.length > MAX_KEY_LENGTH) {
      throw new ApiError(400, 'CHAIN_EXTRACT_KEY_TOO_LONG', `占位标记名称不能超过 ${MAX_KEY_LENGTH} 个字符`, field('key'));
    }
    if (/[{}]/.test(rule.key)) {
      throw new ApiError(400, 'CHAIN_EXTRACT_KEY_INVALID', `占位标记名称「${rule.key}」里不能出现花括号`, field('key'));
    }
    if (seen.has(rule.key)) {
      throw new ApiError(400, 'CHAIN_EXTRACT_KEY_DUPLICATE', `第 ${stepIndex + 1} 步的占位标记「${rule.key}」重复填写`, field('key'));
    }
    seen.add(rule.key);
    if (!rule.fromStep) {
      throw new ApiError(400, 'CHAIN_EXTRACT_FROM_REQUIRED', `${where}还没有选择从哪一步取值`, field('fromStep'));
    }
    if (!rule.path) {
      throw new ApiError(400, 'CHAIN_EXTRACT_PATH_REQUIRED', `${where}还没有填写取值路径`, field('path'));
    }
    if (rule.path.length > MAX_PATH_LENGTH) {
      throw new ApiError(400, 'CHAIN_EXTRACT_PATH_TOO_LONG', `取值路径不能超过 ${MAX_PATH_LENGTH} 个字符`, field('path'));
    }
    if (!parseExtractPath(rule.path)) {
      throw new ApiError(400, 'CHAIN_EXTRACT_PATH_INVALID', `${where}的取值路径「${rule.path}」写法不正确，示例：items[0].id`, field('path'));
    }
    return rule;
  });
}

// 链路步骤的公共整理：保存与运行走同一套，保证两边判断一致
function normalizeChainSteps(payload, cases) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const rawSteps = Array.isArray(input.steps) ? input.steps : [];
  if (!rawSteps.length) throw new ApiError(400, 'CHAIN_STEPS_REQUIRED', '链路里至少要有一步', 'steps');
  if (rawSteps.length > MAX_STEP_COUNT) {
    throw new ApiError(400, 'CHAIN_TOO_MANY_STEPS', `一条链路最多 ${MAX_STEP_COUNT} 步`, 'steps');
  }
  const caseIds = new Set((cases || []).map((item) => item.id));
  const steps = rawSteps.map((raw, index) => {
    const source = raw && typeof raw === 'object' ? raw : {};
    const skipped = source.skipped === true;
    const caseId = typeof source.caseId === 'string' ? source.caseId : '';
    if (!skipped) {
      if (!caseId) throw new ApiError(400, 'CHAIN_STEP_CASE_REQUIRED', `第 ${index + 1} 步还没有选择用例`, `steps.${index}.caseId`);
      if (!caseIds.has(caseId)) {
        throw new ApiError(400, 'CHAIN_STEP_CASE_MISSING', `第 ${index + 1} 步选择的用例不存在或已被删除`, `steps.${index}.caseId`);
      }
    }
    return {
      id: typeof source.id === 'string' && source.id ? source.id : `step-${crypto.randomUUID()}`,
      caseId,
      skipped,
      extracts: normalizeExtracts(source.extracts, index, skipped),
    };
  });
  const seen = new Set();
  steps.forEach((step, index) => {
    if (seen.has(step.id)) {
      throw new ApiError(400, 'CHAIN_STEP_ID_DUPLICATE', `第 ${index + 1} 步与前面的步骤编号重复，请重新编辑链路`, `steps.${index}`);
    }
    seen.add(step.id);
  });
  return steps;
}

// 在未跳过的步骤之间找互相依赖绕成一圈的情况，找到时返回圈上的步骤编号
function findDependencyCycle(steps) {
  const graph = new Map();
  steps.forEach((step) => {
    if (!step.skipped) graph.set(step.id, []);
  });
  steps.forEach((step) => {
    if (step.skipped) return;
    step.extracts.forEach((rule) => {
      if (graph.has(rule.fromStep)) graph.get(step.id).push(rule.fromStep);
    });
  });
  const mark = new Map(); // 1 表示正在这条路上，2 表示已经走完
  const stack = [];
  let cycle = null;
  const visit = (id) => {
    if (cycle) return;
    mark.set(id, 1);
    stack.push(id);
    (graph.get(id) || []).forEach((dep) => {
      if (cycle) return;
      const state = mark.get(dep) || 0;
      if (state === 0) visit(dep);
      else if (state === 1) cycle = stack.slice(stack.indexOf(dep));
    });
    stack.pop();
    mark.set(id, 2);
  };
  graph.forEach((_deps, id) => {
    if (!cycle && !mark.get(id)) visit(id);
  });
  return cycle;
}

// 依赖检查：指向的步骤要存在、不能绕成一圈、取值时来源步骤必须已经执行
function validateChainDependencies(steps) {
  const indexById = new Map();
  steps.forEach((step, index) => indexById.set(step.id, index));

  steps.forEach((step, index) => {
    if (step.skipped) return;
    step.extracts.forEach((rule, ruleIndex) => {
      if (!indexById.has(rule.fromStep)) {
        throw new ApiError(
          400,
          'CHAIN_EXTRACT_FROM_MISSING',
          `第 ${index + 1} 步的注入「{{${rule.key}}}」指向了链路里不存在的步骤`,
          `steps.${index}.extracts.${ruleIndex}.fromStep`
        );
      }
    });
  });

  const cycle = findDependencyCycle(steps);
  if (cycle) {
    const labels = cycle.map((id) => `第 ${indexById.get(id) + 1} 步`).join(' 与 ');
    throw new ApiError(400, 'CHAIN_DEPENDENCY_CYCLE', `链路里 ${labels} 互相依赖，绕成了一圈，请调整取值方向`, 'steps');
  }

  steps.forEach((step, index) => {
    if (step.skipped) return;
    step.extracts.forEach((rule, ruleIndex) => {
      const fromIndex = indexById.get(rule.fromStep);
      const field = `steps.${index}.extracts.${ruleIndex}.fromStep`;
      if (fromIndex >= index) {
        throw new ApiError(
          400,
          'CHAIN_EXTRACT_FROM_LATER',
          `第 ${index + 1} 步的注入「{{${rule.key}}}」指向的第 ${fromIndex + 1} 步排在本步之后，取值时它还没执行`,
          field
        );
      }
      if (steps[fromIndex].skipped) {
        throw new ApiError(
          400,
          'CHAIN_EXTRACT_FROM_SKIPPED',
          `第 ${index + 1} 步的注入「{{${rule.key}}}」指向的第 ${fromIndex + 1} 步已被跳过，不会执行`,
          field
        );
      }
    });
  });
}

function listChains() {
  const data = load();
  return (data.chains || [])
    .slice()
    .sort((a, b) => {
      if (a.updatedAt === b.updatedAt) return a.id < b.id ? 1 : -1;
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });
}

function getChain(id) {
  const data = load();
  const found = (data.chains || []).find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'CHAIN_NOT_FOUND', '链路不存在或已被删除', '');
  return found;
}

function createChain(payload) {
  const data = load();
  const name = validateChainName(payload);
  const steps = normalizeChainSteps(payload, data.cases);
  validateChainDependencies(steps);
  const now = new Date().toISOString();
  const created = { id: `chain-${crypto.randomUUID()}`, name, steps, createdAt: now, updatedAt: now };
  data.chains.push(created);
  save(data);
  return created;
}

function updateChain(id, payload) {
  const data = load();
  const index = (data.chains || []).findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'CHAIN_NOT_FOUND', '链路不存在或已被删除', '');
  const name = validateChainName(payload);
  const steps = normalizeChainSteps(payload, data.cases);
  validateChainDependencies(steps);
  const updated = { ...data.chains[index], name, steps, updatedAt: new Date().toISOString() };
  data.chains[index] = updated;
  save(data);
  return updated;
}

// 删除只动链路本身，链路里引用的用例原样保留
function deleteChain(id) {
  const data = load();
  const index = (data.chains || []).findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'CHAIN_NOT_FOUND', '链路不存在或已被删除', '');
  const [removed] = data.chains.splice(index, 1);
  save(data);
  return { id: removed.id, name: removed.name };
}

// 把取到的值整理成可以写进请求的文本：结构化取值按 JSON 文本放回去
function stringifyExtracted(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return JSON.stringify(value);
}

// 在响应内容里按路径取值：响应不是结构化数据、路径指向的位置不存在，都取不到
function extractFromBody(body, path) {
  const text = typeof body === 'string' ? body : '';
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: 'not-json' };
  }
  const segments = parseExtractPath(path) || [];
  let current = data;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return { ok: false, reason: 'missing', segment };
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment) || Number(segment) >= current.length) {
        return { ok: false, reason: 'missing', segment };
      }
      current = current[Number(segment)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return { ok: false, reason: 'missing', segment };
      current = current[segment];
    }
  }
  return { ok: true, value: stringifyExtracted(current) };
}

// 把模板里写好的 {{标记}} 换成取到的值，没有对应规则的标记原样保留
function injectPlaceholders(text, values) {
  let output = typeof text === 'string' ? text : '';
  values.forEach((value, key) => {
    output = output.replace(placeholderPattern(key), () => value);
  });
  return output;
}

// 记录每个占位标记出现在用例内容的哪些位置，运行结果里据此说明值被换到了哪里
function locatePlaceholder(template, key) {
  const pattern = placeholderPattern(key);
  const targets = [];
  if (pattern.test(template.url)) targets.push('url');
  template.headers.forEach((row, index) => {
    pattern.lastIndex = 0;
    if (pattern.test(row.key) || pattern.test(row.value)) targets.push(`header.${index}`);
  });
  pattern.lastIndex = 0;
  if (pattern.test(template.body)) targets.push('body');
  return targets;
}

// 按顺序执行链路：先取好本步需要的值并换进模板，校验通过再真正发出去；
// 任何一步取不到值或发不出去，整条链路当场停下并说明是第几步的哪一处
async function runChain(payload, port) {
  const startedAt = Date.now();
  const data = load();
  const steps = normalizeChainSteps(payload, data.cases);
  validateChainDependencies(steps);
  if (!steps.some((step) => !step.skipped)) {
    throw new ApiError(400, 'CHAIN_ALL_SKIPPED', '链路里的步骤都被跳过了，至少恢复一步再运行', 'steps');
  }
  const casesById = new Map(data.cases.map((item) => [item.id, item]));
  const indexById = new Map(steps.map((step, index) => [step.id, index]));

  const done = [];
  const responses = new Map();
  const finish = (ok, failure) => ({
    ok,
    steps: done,
    failure: failure || null,
    totalMs: Date.now() - startedAt,
    finishedAt: new Date().toISOString(),
  });

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const caseItem = casesById.get(step.caseId) || null;
    const base = {
      index,
      stepId: step.id,
      caseId: step.caseId,
      caseName: caseItem ? caseItem.name : '',
      skipped: step.skipped,
    };
    if (step.skipped) {
      done.push({ ...base, injections: [], request: null, result: null });
      continue;
    }

    // 先把本步需要的值全部取好，任何一处取不到都不发这一步
    const values = new Map();
    const injections = [];
    for (const rule of step.extracts) {
      const source = responses.get(rule.fromStep);
      const sourceIndex = indexById.get(rule.fromStep);
      const extracted = extractFromBody(source && source.body, rule.path);
      if (!extracted.ok) {
        const reason = extracted.reason === 'not-json'
          ? `第 ${sourceIndex + 1} 步的响应不是结构化数据，没法按路径取值`
          : `路径「${rule.path}」在第 ${sourceIndex + 1} 步的响应里找不到`;
        return finish(false, { stepIndex: index, message: `第 ${index + 1} 步的注入「{{${rule.key}}}」取值失败：${reason}` });
      }
      values.set(rule.key, extracted.value);
      injections.push({ key: rule.key, fromStep: rule.fromStep, fromIndex: sourceIndex, path: rule.path, value: extracted.value });
    }

    const template = { url: caseItem.url, headers: caseItem.headers, body: caseItem.body };
    injections.forEach((injection) => {
      injection.targets = locatePlaceholder(template, injection.key);
    });

    const draft = {
      method: caseItem.method,
      url: injectPlaceholders(caseItem.url, values),
      headers: caseItem.headers.map((row) => ({
        key: injectPlaceholders(row.key, values),
        value: injectPlaceholders(row.value, values),
      })),
      body: injectPlaceholders(caseItem.body, values),
    };

    let normalized = null;
    try {
      normalized = normalizeRequestDraft(draft);
    } catch (err) {
      const detail = err instanceof ApiError ? err.message : '替换后的请求内容不成立';
      return finish(false, { stepIndex: index, message: `第 ${index + 1} 步换入取值后的请求内容不成立：${detail}` });
    }

    const result = await target.sendOutgoing(normalized, port);
    done.push({ ...base, injections, request: normalized, result });
    if (!result.ok) {
      return finish(false, { stepIndex: index, message: `第 ${index + 1} 步的请求没有完成：${result.failure.reason}` });
    }
    responses.set(step.id, result);
  }

  return finish(true, null);
}

module.exports = {
  listChains,
  getChain,
  createChain,
  updateChain,
  deleteChain,
  runChain,
  parseExtractPath,
};
