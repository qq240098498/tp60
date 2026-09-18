// 多步链路：链路按编号引用已保存的用例，每一步可以把前面某一步响应里取到的值
// 注入到自己的目标地址、某一行请求头或请求内容里。
// 本模块负责链路的存取、静态校验（保存/预览时）与顺序执行（发送时）。

const crypto = require('crypto');
const { load, save } = require('./store');
const { ApiError, normalizeRequestDraft } = require('./api');
const target = require('./target');

const MAX_NAME_LENGTH = 60;
const MAX_STEPS = 20;
const MAX_BINDINGS_PER_STEP = 10;
const MAX_HEADER_KEY_LENGTH = 100;
const MAX_PATH_LENGTH = 200;

// 预览时嵌在文本里的取值占位符，页面据此把「取自第几步的哪一段」高亮出来
// 形如 {{@step=1@items[0].id}}，正式发送时不会带这个占位符，而是换成真实取值
const PREVIEW_TOKEN_PATTERN = /\{\{@step=(\d+)@([^}]*?)\}\}/;

function pickText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(status, code, message, field) {
  throw new ApiError(status, code, message, field || '');
}

// ---------------- 取值路径解析 ----------------
// 支持 a.b、a[0]、a["b-c"]、a['b-c'] 这几种写法，返回 key/index 令牌序列

function parseValuePath(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, tokens: null, reason: '取值路径不能为空' };
  if (text.length > MAX_PATH_LENGTH) {
    return { ok: false, tokens: null, reason: `取值路径不能超过 ${MAX_PATH_LENGTH} 个字符` };
  }
  if (text.startsWith('.') || text.includes('..')) {
    return { ok: false, tokens: null, reason: '取值路径里有多余的点，请检查写法' };
  }

  const tokens = [];
  let index = 0;
  let expectPart = true;

  while (index < text.length) {
    const char = text[index];
    if (char === '.') {
      if (expectPart) return { ok: false, tokens: null, reason: '取值路径里的点前后需要填写字段名' };
      index += 1;
      expectPart = true;
      continue;
    }
    if (char === '[') {
      const close = text.indexOf(']', index + 1);
      if (close === -1) return { ok: false, tokens: null, reason: '取值路径里的方括号没有闭合' };
      const inner = text.slice(index + 1, close).trim();
      if (!inner) return { ok: false, tokens: null, reason: '方括号里需要填写下标或字段名' };
      if (/^-?\d+$/.test(inner)) {
        const num = Number(inner);
        if (num < 0) return { ok: false, tokens: null, reason: '数组下标不能是负数' };
        tokens.push({ kind: 'index', value: num });
      } else {
        const quote = inner[0];
        let key = inner;
        if ((quote === '"' || quote === "'") && inner[inner.length - 1] === quote && inner.length >= 2) {
          key = inner.slice(1, -1);
        } else if (!/^[A-Za-z_$][\w$]*$/.test(inner)) {
          return { ok: false, tokens: null, reason: '方括号里的字段名需要加引号，例如 ["订单编号"]' };
        }
        if (!key) return { ok: false, tokens: null, reason: '方括号里的字段名不能为空' };
        tokens.push({ kind: 'key', value: key });
      }
      index = close + 1;
      expectPart = false;
      continue;
    }

    // 普通字段名：读到下一个点或方括号为止
    let end = index;
    while (end < text.length && text[end] !== '.' && text[end] !== '[') end += 1;
    const part = text.slice(index, end);
    if (!/^[A-Za-z_$][\w$-]*$/.test(part)) {
      return { ok: false, tokens: null, reason: `取值路径里的字段名「${part}」不合法` };
    }
    tokens.push({ kind: 'key', value: part });
    index = end;
    expectPart = false;
  }

  if (!tokens.length) return { ok: false, tokens: null, reason: '取值路径不能为空' };
  return { ok: true, tokens, reason: '' };
}

// 按令牌严格取值：任何一级不存在、类型不匹配都算取不到
function resolveTokens(root, tokens) {
  let current = root;
  for (const token of tokens) {
    if (current === null || current === undefined) return { ok: false, value: undefined };
    if (token.kind === 'index') {
      if (!Array.isArray(current)) return { ok: false, value: undefined };
      if (token.value >= current.length) return { ok: false, value: undefined };
      current = current[token.value];
    } else {
      if (typeof current !== 'object' || Array.isArray(current)) return { ok: false, value: undefined };
      if (!Object.prototype.hasOwnProperty.call(current, token.value)) {
        return { ok: false, value: undefined };
      }
      current = current[token.value];
    }
  }
  return { ok: true, value: current };
}

// 按令牌写入：父级必须存在，末级字段不存在时新建，数组按下标写入
function setTokens(root, tokens, value) {
  let current = root;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i];
    if (token.kind === 'index') {
      if (!Array.isArray(current) || token.value >= current.length) return false;
    } else if (typeof current !== 'object' || Array.isArray(current) || current[token.value] === undefined) {
      return false;
    }
    current = current[token.value];
  }
  const last = tokens[tokens.length - 1];
  if (last.kind === 'index') {
    if (!Array.isArray(current) || last.value >= current.length) return false;
    current[last.value] = value;
  } else {
    if (typeof current !== 'object' || Array.isArray(current)) return false;
    current[last.value] = value;
  }
  return true;
}

function resolvePathText(root, rawPath) {
  const parsed = parseValuePath(rawPath);
  if (!parsed.ok) return { ok: false, value: undefined, syntax: false };
  const result = resolveTokens(root, parsed.tokens);
  return result.ok ? { ok: true, value: result.value, syntax: true } : { ok: false, value: undefined, syntax: true };
}

// ---------------- 数据整理 ----------------

function normalizeBinding(source) {
  const item = source && typeof source === 'object' ? source : {};
  return {
    id: typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID(),
    target: pickText(item.target),
    headerKey: typeof item.headerKey === 'string' ? item.headerKey : '',
    path: typeof item.path === 'string' ? item.path.trim() : '',
    sourceStepId: typeof item.sourceStepId === 'string' ? item.sourceStepId : '',
    valuePath: typeof item.valuePath === 'string' ? item.valuePath.trim() : '',
  };
}

function normalizeStep(source) {
  const item = source && typeof source === 'object' ? source : {};
  const bindings = Array.isArray(item.bindings) ? item.bindings.map(normalizeBinding) : [];
  return {
    id: typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID(),
    caseId: pickText(item.caseId),
    enabled: item.enabled !== false,
    bindings,
  };
}

function normalizeChain(source, fallbackId) {
  const item = source && typeof source === 'object' ? source : {};
  const createdAt = typeof item.createdAt === 'string' && item.createdAt ? item.createdAt : new Date().toISOString();
  const steps = Array.isArray(item.steps) ? item.steps.map(normalizeStep).slice(0, MAX_STEPS) : [];
  return {
    id: typeof item.id === 'string' && item.id ? item.id : fallbackId || crypto.randomUUID(),
    name: typeof item.name === 'string' ? item.name : '',
    steps,
    createdAt,
    updatedAt: typeof item.updatedAt === 'string' && item.updatedAt ? item.updatedAt : createdAt,
  };
}

// ---------------- 静态校验 ----------------
// 保存与预览、发送都先走这里：用例存在性、注入位置、来源步骤先后、依赖环一次查清

function validateChainShape(chain, options) {
  const running = !!(options && options.running);
  const data = load();
  const caseMap = new Map(data.cases.map((item) => [item.id, item]));

  const name = pickText(chain.name);
  if (!name) fail(400, 'CHAIN_NAME_REQUIRED', '请填写链路名称', 'name');
  if (name.length > MAX_NAME_LENGTH) {
    fail(400, 'CHAIN_NAME_TOO_LONG', `链路名称不能超过 ${MAX_NAME_LENGTH} 个字符`, 'name');
  }

  if (!Array.isArray(chain.steps) || !chain.steps.length) {
    fail(400, 'CHAIN_STEPS_REQUIRED', '链路里至少需要添加一步', 'steps');
  }
  if (chain.steps.length > MAX_STEPS) {
    fail(400, 'CHAIN_STEPS_TOO_MANY', `一条链路最多 ${MAX_STEPS} 步`, 'steps');
  }

  // 步骤自身编号用「在编辑区里的序号」，跳过的步骤也占编号，和页面显示一致
  const stepInfo = chain.steps.map((step, index) => ({
    step,
    index,
    ordinal: index + 1,
    case: step.caseId ? caseMap.get(step.caseId) : undefined,
  }));
  const idToInfo = new Map(stepInfo.map((info) => [info.step.id, info]));

  stepInfo.forEach((info) => {
    const { step, ordinal } = info;
    if (!step.caseId) {
      fail(400, 'CHAIN_STEP_CASE_REQUIRED', `第 ${ordinal} 步还没有选择用例`, `steps[${info.index}].caseId`);
    }
    if (!info.case) {
      fail(404, 'CHAIN_STEP_CASE_MISSING', `第 ${ordinal} 步引用的用例不存在或已被删除，请重新选择`, `steps[${info.index}].caseId`);
    }
    if (step.bindings.length > MAX_BINDINGS_PER_STEP) {
      fail(400, 'CHAIN_BINDINGS_TOO_MANY', `第 ${ordinal} 步最多配置 ${MAX_BINDINGS_PER_STEP} 个取值`, `steps[${info.index}].bindings`);
    }
  });

  // 依赖图：边从我指向来源步骤，用于环检测；同时核对来源是否在本步之前
  const edges = new Map();
  stepInfo.forEach((info) => (edges.set(info.step.id, [])));

  // 第一遍：校验注入位置类型与来源步骤本身（存在、不是自己、未被跳过），并搭好依赖图
  // 被临时跳过的步骤本身不执行，它配置了什么取值都不影响链路，因此不校验也不入图
  stepInfo.forEach((info) => {
    const { step, ordinal } = info;
    if (!step.enabled) return;
    step.bindings.forEach((binding, bindIndex) => {
      const place = `第 ${ordinal} 步的第 ${bindIndex + 1} 个取值`;
      const field = `steps[${info.index}].bindings[${bindIndex}]`;

      if (!['url', 'header', 'body'].includes(binding.target)) {
        fail(400, 'CHAIN_TARGET_INVALID', `${place}没有选择注入位置（地址、请求头或请求内容）`, `${field}.target`);
      }
      if (!binding.sourceStepId) {
        fail(400, 'CHAIN_SOURCE_REQUIRED', `${place}没有选择从哪一步取值`, `${field}.sourceStepId`);
      }
      const source = idToInfo.get(binding.sourceStepId);
      if (!source) {
        fail(400, 'CHAIN_SOURCE_NOT_FOUND', `${place}的来源步骤在链路里不存在，请重新选择`, `${field}.sourceStepId`);
      }
      if (source.step.id === step.id) {
        fail(400, 'CHAIN_SOURCE_SELF', `${place}不能从本步自己取值，本步还没有响应`, `${field}.sourceStepId`);
      }
      if (!source.step.enabled) {
        fail(400, 'CHAIN_SOURCE_SKIPPED', `${place}的来源第 ${source.ordinal} 步已被跳过，跳过的步骤不会产生响应`, `${field}.sourceStepId`);
      }
      edges.get(step.id).push(source.step.id);
    });
  });

  // 环检测优先于前向引用检查：调整先后顺序后可能绕成一圈，要明确指出闭环经过了哪几步
  const cycle = findCycle(stepInfo, edges);
  if (cycle) {
    const text = cycle.map((entry) => `第 ${entry.ordinal} 步`).join(' → ');
    fail(400, 'CHAIN_CYCLE', `链路里出现了互相依赖绕成一圈的情况：${text}，请改成都从前面的步骤取值`, 'steps');
  }

  // 第二遍：校验来源先后、取值路径与具体注入位置
  stepInfo.forEach((info) => {
    const { step, ordinal, case: useCase } = info;
    if (!step.enabled) return;
    step.bindings.forEach((binding, bindIndex) => {
      const place = `第 ${ordinal} 步的第 ${bindIndex + 1} 个取值`;
      const field = `steps[${info.index}].bindings[${bindIndex}]`;
      const source = idToInfo.get(binding.sourceStepId);

      if (source.ordinal >= ordinal) {
        fail(400, 'CHAIN_SOURCE_FORWARD', `${place}指向了排在后面的第 ${source.ordinal} 步，那一步还没执行，没有结果可取`, `${field}.sourceStepId`);
      }

      const parsedPath = parseValuePath(binding.valuePath);
      if (!parsedPath.ok) {
        fail(400, 'CHAIN_VALUE_PATH_INVALID', `${place}的取值路径不合法：${parsedPath.reason}`, `${field}.valuePath`);
      }

      if (binding.target === 'header') {
        const headerKey = pickText(binding.headerKey);
        if (!headerKey) {
          fail(400, 'CHAIN_HEADER_KEY_REQUIRED', `${place}没有填写要注入的请求头名称`, `${field}.headerKey`);
        }
        if (headerKey.length > MAX_HEADER_KEY_LENGTH) {
          fail(400, 'CHAIN_HEADER_KEY_TOO_LONG', `${place}的请求头名称过长`, `${field}.headerKey`);
        }
        const matched = useCase.headers.find((row) => row.key.toLowerCase() === headerKey.toLowerCase());
        if (!matched) {
          fail(400, 'CHAIN_HEADER_NOT_FOUND', `${place}要注入的请求头「${headerKey}」在该用例里不存在，请在用例里先补上这一行`, `${field}.headerKey`);
        }
      }

      if (binding.target === 'body') {
        if (!useCase.body.trim()) {
          fail(400, 'CHAIN_BODY_EMPTY', `${place}要注入请求内容，但该用例的请求内容为空`, `${field}.path`);
        }
        const isJson = useCase.headers.some(
          (row) => row.key.toLowerCase() === 'content-type' && row.value.toLowerCase().includes('json')
        );
        if (!isJson) {
          fail(400, 'CHAIN_BODY_NOT_JSON', `${place}只能注入 JSON 请求内容，请先把该用例的 Content-Type 设为 application/json`, `${field}.path`);
        }
        let parsedBody = null;
        try {
          parsedBody = JSON.parse(useCase.body);
        } catch (err) {
          fail(400, 'CHAIN_BODY_INVALID_JSON', `${place}所在用例的请求内容不是合法 JSON：${err.message}`, `${field}.path`);
        }
        const injectParsed = parseValuePath(binding.path);
        if (!injectParsed.ok) {
          fail(400, 'CHAIN_INJECT_PATH_INVALID', `${place}在请求内容里的位置不合法：${injectParsed.reason}`, `${field}.path`);
        }
        const located = resolveTokens(parsedBody, injectParsed.tokens);
        if (!located.ok) {
          fail(400, 'CHAIN_INJECT_PATH_NOT_FOUND', `${place}在请求内容里找不到位置「${binding.path}」，请先在用例内容里留出这个字段`, `${field}.path`);
        }
      }

      if (binding.target === 'url') {
        const queryKey = pickText(binding.path);
        if (!queryKey) {
          fail(400, 'CHAIN_QUERY_KEY_REQUIRED', `${place}没有填写目标地址里的查询参数名`, `${field}.path`);
        }
        if (!/^[A-Za-z0-9_.-]+$/.test(queryKey)) {
          fail(400, 'CHAIN_QUERY_KEY_INVALID', `${place}的查询参数名「${queryKey}」不合法，只支持字母、数字、点、下划线与中划线`, `${field}.path`);
        }
      }
    });
  });

  if (running && !stepInfo.some((info) => info.step.enabled)) {
    fail(400, 'CHAIN_ALL_SKIPPED', '链路里的步骤都被跳过了，至少要保留一步再发送', 'steps');
  }

  return { name, stepInfo };
}

function findCycle(stepInfo, edges) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map(stepInfo.map((info) => [info.step.id, WHITE]));
  const infoById = new Map(stepInfo.map((info) => [info.step.id, info]));
  const stack = [];

  function dfs(nodeId) {
    color.set(nodeId, GRAY);
    stack.push(nodeId);
    for (const next of edges.get(nodeId) || []) {
      if (color.get(next) === GRAY) {
        const start = stack.indexOf(next);
        const loop = stack.slice(start).concat(next);
        return loop.map((id) => infoById.get(id));
      }
      if (color.get(next) === WHITE) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(nodeId, BLACK);
    return null;
  }

  for (const info of stepInfo) {
    if (color.get(info.step.id) === WHITE) {
      const found = dfs(info.step.id);
      if (found) return found;
    }
  }
  return null;
}

// ---------------- 预览 ----------------

function previewToken(sourceOrdinal, valuePath) {
  return `{{@step=${sourceOrdinal}@${valuePath}}}`;
}

// 不真正发送，把每一步的地址、请求头、请求内容按绑定位置换上取值占位符
function buildPreview(chain) {
  const { stepInfo } = validateChainShape(chain, { running: false });

  return stepInfo.map((info) => {
    const { step, ordinal, case: useCase } = info;
    if (!step.enabled) {
      return {
        ordinal,
        stepId: step.id,
        caseId: useCase.id,
        caseName: useCase.name,
        enabled: false,
        method: useCase.method,
        url: useCase.url,
        headers: useCase.headers.map((row) => ({ key: row.key, value: row.value })),
        body: useCase.body,
        injections: [],
      };
    }

    let url = useCase.url;
    const headers = useCase.headers.map((row) => ({ key: row.key, value: row.value }));
    let bodyText = useCase.body;

    const injections = step.bindings.map((binding) => {
      const source = stepInfo.find((item) => item.step.id === binding.sourceStepId);
      const token = previewToken(source.ordinal, binding.valuePath);
      if (binding.target === 'url') {
        // 预览时保留可读占位符，让页面能高亮并标明来源；真正发送时才对取值做编码
        url = setQueryValue(url, binding.path, token, false);
      } else if (binding.target === 'header') {
        const row = headers.find((item) => item.key.toLowerCase() === binding.headerKey.trim().toLowerCase());
        if (row) row.value = token;
      } else if (binding.target === 'body') {
        const parsedBody = JSON.parse(useCase.body);
        const parsed = parseValuePath(binding.path);
        setTokens(parsedBody, parsed.tokens, token);
        bodyText = JSON.stringify(parsedBody, null, 2);
      }
      return {
        target: binding.target,
        headerKey: binding.headerKey.trim(),
        path: binding.path,
        sourceOrdinal: source.ordinal,
        sourceCaseName: source.case.name,
        valuePath: binding.valuePath,
      };
    });

    return {
      ordinal,
      stepId: step.id,
      caseId: useCase.id,
      caseName: useCase.name,
      enabled: true,
      method: useCase.method,
      url,
      headers,
      body: bodyText,
      injections,
    };
  });
}

// 在地址上设置查询参数：已有同名参数就替换第一个，没有就追加
// encode=false 用于预览，保留可读占位符；正式发送时对取值做编码
function setQueryValue(rawUrl, key, value, encode) {
  const enc = encode === false ? (text) => text : encodeURIComponent;
  if (rawUrl.indexOf('?') === -1) {
    return key ? `${rawUrl}?${enc(key)}=${enc(value)}` : `${rawUrl}${enc(value)}`;
  }
  const queryIndex = rawUrl.indexOf('?');
  const base = rawUrl.slice(0, queryIndex + 1);
  const queryText = rawUrl.slice(queryIndex + 1);
  const pairs = queryText.length ? queryText.split('&') : [];
  let replaced = false;
  const next = pairs.map((pair) => {
    const eq = pair.indexOf('=');
    const name = eq === -1 ? pair : pair.slice(0, eq);
    if (key && decodeURIComponent(name) === key) {
      replaced = true;
      return `${enc(key)}=${enc(value)}`;
    }
    return pair;
  });
  if (!replaced) next.push(`${enc(key)}=${enc(value)}`);
  return `${base}${next.join('&')}`;
}

// ---------------- 执行 ----------------

function valueToText(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// 顺序执行链路：每一步先按前序响应取值注入，再发送；任一步失败就停下并指出位置
async function executeChain(saved, port, caseSource) {
  validateChainShape(saved, { running: true });

  // 只对启用步骤重新编号，执行顺序里的「第 N 步」按实际发送次序
  const active = saved.steps
    .map((step, index) => ({ step, index, ordinal: index + 1 }))
    .filter((item) => item.step.enabled);
  const caseMap = new Map(caseSource.map((item) => [item.id, item]));
  const responseByStepId = new Map();
  const results = [];

  for (let n = 0; n < active.length; n += 1) {
    const info = active[n];
    const { step } = info;
    const useCase = caseMap.get(step.caseId);
    const sendOrdinal = n + 1;

    // 运行期才暴露的问题（前序响应取不到值等）：保留已发送步骤的结果，连同原因一起返回
    const abort = (reasonText) => ({
      ok: false,
      stoppedAt: sendOrdinal,
      reason: reasonText,
      results,
      skipped: describeSkipped(saved),
    });

    let url = useCase.url;
    const headers = useCase.headers.map((row) => ({ key: row.key, value: row.value }));
    let bodyParsed = null;
    const bodyIsJson = useCase.headers.some(
      (row) => row.key.toLowerCase() === 'content-type' && row.value.toLowerCase().includes('json')
    );
    if (bodyIsJson && useCase.body.trim()) bodyParsed = JSON.parse(useCase.body);

    const injections = [];
    for (let bindIndex = 0; bindIndex < step.bindings.length; bindIndex += 1) {
      const binding = step.bindings[bindIndex];
      const sourceInfo = active.slice(0, n).find((item) => item.step.id === binding.sourceStepId);
      const place = `第 ${sendOrdinal} 步的第 ${bindIndex + 1} 个取值`;
      // 静态校验已保证来源在前且启用，这里到不了来源缺失，兜底再挡一次
      if (!sourceInfo) {
        return abort(`${place}的来源步骤还没有执行`);
      }
      const sourceResponse = responseByStepId.get(binding.sourceStepId);
      const sourceSendOrdinal = active.indexOf(sourceInfo) + 1;
      if (!sourceResponse) {
        return abort(`${place}的来源第 ${sourceSendOrdinal} 步没有可用响应`);
      }
      let parsedResponse = null;
      try {
        parsedResponse = JSON.parse(sourceResponse.body);
      } catch (err) {
        return abort(`第 ${sourceSendOrdinal} 步的响应不是结构化数据，无法按「${binding.valuePath}」取值`);
      }
      const looked = resolvePathText(parsedResponse, binding.valuePath);
      if (!looked.ok) {
        return abort(`第 ${sendOrdinal} 步要取的「${binding.valuePath}」在第 ${sourceSendOrdinal} 步的响应里找不到，请检查取值路径`);
      }
      const extracted = looked.value;
      const extractedText = valueToText(extracted);

      if (binding.target === 'url') {
        url = setQueryValue(url, binding.path, extractedText);
      } else if (binding.target === 'header') {
        const row = headers.find((item) => item.key.toLowerCase() === binding.headerKey.trim().toLowerCase());
        if (!row) return abort(`第 ${sendOrdinal} 步要注入的请求头「${binding.headerKey}」不存在`);
        row.value = extractedText;
      } else {
        const parsedInject = parseValuePath(binding.path);
        const placed = setTokens(bodyParsed, parsedInject.tokens, extracted);
        if (!placed) {
          return abort(`第 ${sendOrdinal} 步在请求内容里找不到位置「${binding.path}」`);
        }
      }

      injections.push({
        target: binding.target,
        headerKey: binding.headerKey.trim(),
        path: binding.path,
        sourceOrdinal: sourceSendOrdinal,
        sourceStepOrdinal: sourceInfo.ordinal,
        valuePath: binding.valuePath,
        value: extractedText,
      });
    }

    const draft = {
      method: useCase.method,
      url,
      headers,
      body: bodyParsed === null ? useCase.body : JSON.stringify(bodyParsed),
    };

    let normalized = null;
    try {
      normalized = normalizeRequestDraft(draft);
    } catch (err) {
      if (err instanceof ApiError) {
        return abort(`第 ${sendOrdinal} 步注入取值后的请求不成立：${err.message}`);
      }
      throw err;
    }

    const result = await target.sendOutgoing(normalized, port);
    responseByStepId.set(step.id, result.ok ? result : null);

    results.push({
      ordinal: sendOrdinal,
      stepOrdinal: info.ordinal,
      stepId: step.id,
      caseId: useCase.id,
      caseName: useCase.name,
      enabled: true,
      draft: normalized,
      injections,
      result,
    });

    if (!result.ok) {
      return {
        ok: false,
        stoppedAt: sendOrdinal,
        reason: `第 ${sendOrdinal} 步请求没有完成：${result.failure.reason}`,
        results,
        skipped: describeSkipped(saved),
      };
    }
    if (result.status >= 400) {
      return {
        ok: false,
        stoppedAt: sendOrdinal,
        reason: `第 ${sendOrdinal} 步返回了失败状态码 ${result.status}，链路已停止`,
        results,
        skipped: describeSkipped(saved),
      };
    }
  }

  return { ok: true, stoppedAt: 0, reason: '', results, skipped: describeSkipped(saved) };
}

function describeSkipped(saved) {
  return saved.steps
    .map((step, index) => ({ step, ordinal: index + 1 }))
    .filter((item) => !item.step.enabled)
    .map((item) => ({ ordinal: item.ordinal, stepId: item.step.id, caseId: item.step.caseId }));
}

// 按已保存链路的编号运行
async function runChain(chainId, port) {
  const data = load();
  const saved = data.chains.find((item) => item.id === chainId);
  if (!saved) fail(404, 'CHAIN_NOT_FOUND', '链路不存在或已被删除', '');
  return executeChain(saved, port, data.cases);
}

// 按页面当前编辑内容直接试跑，不要求先保存；用例仍以已保存的集合为准
async function runChainPayload(payload, port) {
  const data = load();
  const chain = normalizeChain(payload);
  return executeChain(chain, port, data.cases);
}

// ---------------- 存取接口 ----------------

function listChains() {
  const data = load();
  return data.chains
    .slice()
    .sort((a, b) => {
      if (a.createdAt === b.createdAt) return a.id < b.id ? 1 : -1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
}

function getChain(id) {
  const data = load();
  const found = data.chains.find((item) => item.id === id);
  if (!found) fail(404, 'CHAIN_NOT_FOUND', '链路不存在或已被删除', '');
  return found;
}

function saveChain(payload, existingId) {
  const isUpdate = !!existingId;
  const data = load();
  const chain = normalizeChain(payload);
  validateChainShape(chain, { running: false });

  const now = new Date().toISOString();
  if (isUpdate) {
    const index = data.chains.findIndex((item) => item.id === existingId);
    if (index === -1) fail(404, 'CHAIN_NOT_FOUND', '链路不存在或已被删除', '');
    const updated = {
      ...chain,
      id: existingId,
      createdAt: data.chains[index].createdAt,
      updatedAt: now,
    };
    data.chains[index] = updated;
    save(data);
    return { created: false, chain: updated };
  }

  const created = { ...chain, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
  data.chains.push(created);
  save(data);
  return { created: true, chain: created };
}

function deleteChain(id) {
  const data = load();
  const index = data.chains.findIndex((item) => item.id === id);
  if (index === -1) fail(404, 'CHAIN_NOT_FOUND', '链路不存在或已被删除', '');
  const [removed] = data.chains.splice(index, 1);
  save(data);
  // 只删链路本身，步骤引用的用例一条都不动
  return { id: removed.id, name: removed.name };
}

module.exports = {
  ApiError,
  parseValuePath,
  resolvePathText,
  previewChain: (payload) => buildPreview(normalizeChain(payload)),
  runChain,
  runChainPayload,
  listChains,
  getChain,
  saveChain,
  deleteChain,
  PREVIEW_TOKEN_PATTERN,
};
