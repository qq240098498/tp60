const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const TEMP_FILE = path.join(DATA_DIR, 'db.json.tmp');

// 初始数据：维护用例集合与链路集合，链路只按编号引用用例，删除链路不会动到用例
function seedData() {
  return {
    cases: [
      {
        id: 'case-1001',
        name: '回声接口连通性检查',
        method: 'GET',
        url: '/demo/echo?from=workbench',
        headers: [{ key: 'Accept', value: 'application/json' }],
        body: '',
        createdAt: '2026-09-17T01:20:00.000Z',
        updatedAt: '2026-09-17T01:20:00.000Z',
      },
      {
        id: 'case-1002',
        name: '回声接口请求内容回显',
        method: 'POST',
        url: '/demo/echo',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
        body: '{\n  "sku": "SKU-1001",\n  "count": 2\n}',
        createdAt: '2026-09-17T01:45:00.000Z',
        updatedAt: '2026-09-17T01:45:00.000Z',
      },
      {
        id: 'case-1003',
        name: '列表接口分页取值',
        method: 'GET',
        url: '/demo/items?page=2&size=2',
        headers: [{ key: 'Accept', value: 'application/json' }],
        body: '',
        createdAt: '2026-09-17T02:10:00.000Z',
        updatedAt: '2026-09-17T02:10:00.000Z',
      },
      {
        id: 'case-1004',
        name: '报错接口状态码核对',
        method: 'GET',
        url: '/demo/status?code=500',
        headers: [{ key: 'Accept', value: 'application/json' }],
        body: '',
        createdAt: '2026-09-17T02:30:00.000Z',
        updatedAt: '2026-09-17T02:30:00.000Z',
      },
      {
        id: 'case-1005',
        name: '回声接口接收链路取值',
        method: 'POST',
        url: '/demo/echo?orderId=',
        headers: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'X-Order-Id', value: '' },
        ],
        // 用例本身保持干净；把哪个值注进来由链路步骤上的绑定决定，同一条用例可在不同链路里复用
        body: '{\n  "orderId": "",\n  "source": "chain"\n}',
        createdAt: '2026-09-18T03:05:00.000Z',
        updatedAt: '2026-09-18T03:05:00.000Z',
      },
    ],
    chains: [
      {
        id: 'chain-2001',
        name: '列表取编号再回显',
        steps: [
          { id: 'step-2001-1', caseId: 'case-1003', enabled: true, bindings: [] },
          {
            id: 'step-2001-2',
            caseId: 'case-1005',
            enabled: true,
            bindings: [
              { id: 'bind-2001-1', target: 'body', headerKey: '', path: 'orderId', sourceStepId: 'step-2001-1', valuePath: 'items[0].id' },
            ],
          },
        ],
        createdAt: '2026-09-18T03:10:00.000Z',
        updatedAt: '2026-09-18T03:10:00.000Z',
      },
    ],
  };
}

// 把单条用例整理成固定结构，避免数据文件被手工改动后出现缺字段
function normalizeCase(item) {
  const source = item && typeof item === 'object' ? item : {};
  const createdAt = typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : new Date().toISOString();
  return {
    id: typeof source.id === 'string' ? source.id : '',
    name: typeof source.name === 'string' ? source.name : '',
    method: typeof source.method === 'string' && source.method ? source.method.toUpperCase() : 'GET',
    url: typeof source.url === 'string' ? source.url : '',
    headers: Array.isArray(source.headers)
      ? source.headers
          .filter((row) => row && typeof row === 'object')
          .map((row) => ({
            key: typeof row.key === 'string' ? row.key : '',
            value: typeof row.value === 'string' ? row.value : '',
          }))
      : [],
    body: typeof source.body === 'string' ? source.body : '',
    createdAt,
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : createdAt,
  };
}

// 整份数据保证 cases 与 chains 都存在且元素结构一致；chains 只按编号引用用例
function normalizeBinding(item) {  const source = item && typeof item === 'object' ? item : {};
  return {
    id: typeof source.id === 'string' ? source.id : '',
    target: typeof source.target === 'string' ? source.target : '',
    headerKey: typeof source.headerKey === 'string' ? source.headerKey : '',
    path: typeof source.path === 'string' ? source.path : '',
    sourceStepId: typeof source.sourceStepId === 'string' ? source.sourceStepId : '',
    valuePath: typeof source.valuePath === 'string' ? source.valuePath : '',
  };
}

function normalizeChainStep(item) {
  const source = item && typeof item === 'object' ? item : {};
  return {
    id: typeof source.id === 'string' ? source.id : '',
    caseId: typeof source.caseId === 'string' ? source.caseId : '',
    enabled: source.enabled !== false,
    bindings: Array.isArray(source.bindings)
      ? source.bindings.map(normalizeBinding).filter((row) => row.id)
      : [],
  };
}

function normalizeChain(item) {
  const source = item && typeof item === 'object' ? item : {};
  const createdAt = typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : new Date().toISOString();
  return {
    id: typeof source.id === 'string' ? source.id : '',
    name: typeof source.name === 'string' ? source.name : '',
    steps: Array.isArray(source.steps)
      ? source.steps.map(normalizeChainStep).filter((step) => step.id)
      : [],
    createdAt,
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : createdAt,
  };
}

// 整份数据只保证 cases 一定存在且元素结构一致
function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const cases = Array.isArray(source.cases) ? source.cases.map(normalizeCase).filter((item) => item.id) : [];
  const chains = Array.isArray(source.chains) ? source.chains.map(normalizeChain).filter((item) => item.id) : [];
  return { ...source, cases, chains };
}

// 读取数据文件：文件缺失或内容损坏时回落到初始数据并立刻补写
function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return normalize(JSON.parse(raw));
  } catch (err) {
    const data = seedData();
    save(data);
    return data;
  }
}

// 先写临时文件再改名，写入中途被打断也不会把正式数据文件写坏
function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const text = `${JSON.stringify(normalize(data), null, 2)}\n`;
  fs.writeFileSync(TEMP_FILE, text, 'utf8');
  fs.renameSync(TEMP_FILE, DATA_FILE);
}

module.exports = { load, save, seedData, DATA_FILE };
