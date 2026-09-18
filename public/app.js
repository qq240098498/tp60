(function () {
  'use strict';

  // 页面状态：用例列表、内置示例接口、请求头草稿行、最近一次响应结果与结果视图
  const state = {
    cases: [],
    selectedId: '',
    headers: [{ key: '', value: '' }],
    demos: [],
    busy: false,
    result: null,
    resultView: 'structured',
    chains: [],
    chainDraft: emptyChainDraft(),
    chainSavedId: '',
    chainBusy: false,
    chainPreview: [],
    chainPreviewTimer: 0,
    chainResult: null,
  };

  function uid(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return `${prefix || 'id'}-${window.crypto.randomUUID()}`;
    }
    return `${prefix || 'id'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function emptyChainDraft() {
    return { id: '', name: '', steps: [] };
  }

  function emptyBinding() {
    return { id: uid('bind'), target: 'url', headerKey: '', path: '', sourceStepId: '', valuePath: '' };
  }

  const dom = {
    health: document.getElementById('health-badge'),
    notice: document.getElementById('notice'),
    name: document.getElementById('field-name'),
    method: document.getElementById('field-method'),
    url: document.getElementById('field-url'),
    body: document.getElementById('field-body'),
    headerRows: document.getElementById('header-rows'),
    addHeader: document.getElementById('add-header'),
    demos: document.getElementById('demo-list'),
    demoSummary: document.getElementById('demo-summary'),
    sendRequest: document.getElementById('send-request'),
    saveCase: document.getElementById('save-case'),
    resetDraft: document.getElementById('reset-draft'),
    resultBody: document.getElementById('result-body'),
    resultSummary: document.getElementById('result-summary'),
    clearResult: document.getElementById('clear-result'),
    caseList: document.getElementById('case-list'),
    caseSummary: document.getElementById('case-summary'),
    refreshCases: document.getElementById('refresh-cases'),
    caseDetail: document.getElementById('case-detail'),
    closeDetail: document.getElementById('close-detail'),
    chainPicker: document.getElementById('chain-picker'),
    chainName: document.getElementById('chain-name'),
    chainNew: document.getElementById('chain-new'),
    chainSave: document.getElementById('chain-save'),
    chainDelete: document.getElementById('chain-delete'),
    chainSteps: document.getElementById('chain-steps'),
    chainAddStep: document.getElementById('chain-add-step'),
    chainRun: document.getElementById('chain-run'),
    chainHint: document.getElementById('chain-hint'),
    chainError: document.getElementById('chain-error'),
    chainPreview: document.getElementById('chain-preview'),
    chainResultPanel: document.getElementById('chain-result-panel'),
    chainResult: document.getElementById('chain-result'),
    chainClearResult: document.getElementById('chain-clear-result'),
  };

  const emptyDetailHint = '在用例列表点「详情」，这里显示该用例保存下来的目标地址、请求头与请求内容。';
  // 结构化视图最多铺开的层级条目数量，避免内容过大时页面卡顿
  const TREE_LIMIT = 800;
  let noticeTimer = 0;

  // ---------------- 后端交互 ----------------

  // 统一请求入口：把服务端返回的错误码与出错位置打包进异常对象
  async function request(path, options) {
    const config = options || {};
    const init = { method: config.method || 'GET' };
    if (config.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(config.body);
    }

    let response = null;
    try {
      response = await fetch(path, init);
    } catch (err) {
      const error = new Error('无法连接服务，请确认服务已启动');
      error.code = 'NETWORK_ERROR';
      error.field = '';
      throw error;
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      payload = null;
    }

    if (!response.ok) {
      const info = (payload && payload.error) || {};
      const error = new Error(info.message || `操作失败（状态码 ${response.status}）`);
      error.code = info.code || 'request_failed';
      error.field = typeof info.field === 'string' ? info.field : '';
      throw error;
    }
    return payload;
  }

  function setBusy(busy, activeAction) {
    state.busy = busy;
    dom.sendRequest.disabled = busy;
    dom.saveCase.disabled = busy;
    dom.resetDraft.disabled = busy;
    dom.refreshCases.disabled = busy;
    dom.sendRequest.textContent = busy && activeAction === 'send' ? '发送中…' : '发送请求';
    dom.saveCase.textContent = busy && activeAction === 'save' ? '正在保存…' : '保存为用例';
  }

  // ---------------- 页面消息与出错标记 ----------------

  function showNotice(message, type) {
    dom.notice.textContent = message;
    dom.notice.className = `notice notice-${type || 'info'}`;
    dom.notice.hidden = false;
    window.clearTimeout(noticeTimer);
    const stay = type === 'error' ? 6000 : 3500;
    noticeTimer = window.setTimeout(() => {
      dom.notice.hidden = true;
    }, stay);
  }

  function clearFieldErrors() {
    document.querySelectorAll('.field-error').forEach((node) => {
      node.hidden = true;
      node.textContent = '';
    });
    [dom.name, dom.url, dom.body, dom.headerRows].forEach((node) => node.classList.remove('invalid'));
  }

  // 服务端给出的位置可能是 headers.2.key 这种形式，标记时按区块归位
  function normalizeField(field) {
    if (typeof field !== 'string' || !field) return '';
    const key = field.split('.')[0];
    return ['name', 'method', 'url', 'headers', 'body'].includes(key) ? key : '';
  }

  function showFieldError(field, message) {
    const key = normalizeField(field);
    if (!key) return;
    const slot = document.querySelector(`[data-error="${key}"]`);
    if (slot) {
      slot.textContent = message;
      slot.hidden = false;
    }
    const target = {
      name: dom.name,
      method: dom.method,
      url: dom.url,
      headers: dom.headerRows,
      body: dom.body,
    }[key];
    if (target) target.classList.add('invalid');
  }

  // ---------------- 请求区 ----------------

  function renderHeaderRows() {
    dom.headerRows.textContent = '';
    if (!state.headers.length) {
      const empty = document.createElement('p');
      empty.className = 'rows-empty';
      empty.textContent = '暂无请求头';
      dom.headerRows.appendChild(empty);
      return;
    }

    state.headers.forEach((row, index) => {
      const line = document.createElement('div');
      line.className = 'header-row';

      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.className = 'header-key';
      keyInput.value = row.key;
      keyInput.autocomplete = 'off';
      keyInput.dataset.index = String(index);
      keyInput.dataset.part = 'key';
      keyInput.setAttribute('aria-label', `第 ${index + 1} 行请求头名称`);

      const valueInput = document.createElement('input');
      valueInput.type = 'text';
      valueInput.className = 'header-value';
      valueInput.value = row.value;
      valueInput.autocomplete = 'off';
      valueInput.dataset.index = String(index);
      valueInput.dataset.part = 'value';
      valueInput.setAttribute('aria-label', `第 ${index + 1} 行请求头取值`);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-ghost btn-small';
      remove.textContent = '删除';
      remove.dataset.action = 'remove-header';
      remove.dataset.index = String(index);

      line.append(keyInput, valueInput, remove);
      dom.headerRows.appendChild(line);
    });
  }

  function collectDraft() {
    return {
      name: dom.name.value.trim(),
      method: dom.method.value,
      url: dom.url.value.trim(),
      headers: state.headers.map((row) => ({ key: row.key.trim(), value: row.value })),
      body: dom.body.value,
    };
  }

  // 把一份请求内容写回表单，既用于示例接口填入，也用于用例回填
  function fillDraft(draft) {
    dom.name.value = typeof draft.name === 'string' ? draft.name : '';
    dom.method.value = draft.method || 'GET';
    dom.url.value = draft.url || '';
    dom.body.value = typeof draft.body === 'string' ? draft.body : '';
    state.headers = Array.isArray(draft.headers) && draft.headers.length
      ? draft.headers.map((row) => ({
          key: typeof row.key === 'string' ? row.key : '',
          value: typeof row.value === 'string' ? row.value : '',
        }))
      : [{ key: '', value: '' }];
    renderHeaderRows();
    clearFieldErrors();
  }

  function resetDraft(silent) {
    fillDraft({ name: '', method: 'GET', url: '', headers: [], body: '' });
    if (!silent) showNotice('草稿已清空', 'info');
  }

  // ---------------- 内置示例接口 ----------------

  async function loadDemos() {
    try {
      const data = await request('/api/demos');
      state.demos = data && Array.isArray(data.endpoints) ? data.endpoints : [];
    } catch (err) {
      state.demos = [];
    }
    renderDemos();
  }

  function renderDemos() {
    dom.demos.textContent = '';
    if (!state.demos.length) {
      dom.demoSummary.textContent = '读取失败';
      const hint = document.createElement('p');
      hint.className = 'rows-empty';
      hint.textContent = '内置示例接口暂时读取不到，可以直接在目标地址里填写完整地址';
      dom.demos.appendChild(hint);
      return;
    }

    dom.demoSummary.textContent = `共 ${state.demos.length} 个`;
    state.demos.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'demo-item';

      const main = document.createElement('div');
      main.className = 'demo-main';

      const title = document.createElement('div');
      title.className = 'demo-title';
      const nameNode = document.createElement('span');
      nameNode.className = 'demo-name';
      nameNode.textContent = item.name;
      title.append(nameNode, buildTag(item.method, item.method === 'GET' ? 'get' : 'any'));

      const pathNode = document.createElement('p');
      pathNode.className = 'demo-path';
      pathNode.textContent = item.path;

      const summaryNode = document.createElement('p');
      summaryNode.className = 'demo-summary';
      summaryNode.textContent = item.summary;

      main.append(title, pathNode, summaryNode);

      const fill = document.createElement('button');
      fill.type = 'button';
      fill.className = 'btn btn-small';
      fill.textContent = '填入请求区';
      fill.addEventListener('click', () => {
        fillDraft(item.example);
        state.selectedId = '';
        renderCases();
        showNotice(`已把「${item.name}」填入请求区，点发送请求即可看到结果`, 'info');
      });

      row.append(main, fill);
      dom.demos.appendChild(row);
    });
  }

  // ---------------- 发送请求与结果展示 ----------------

  async function sendRequest() {
    if (state.busy) return;
    clearFieldErrors();

    const draft = collectDraft();
    if (!draft.url) {
      showFieldError('url', '请填写目标地址');
      showNotice('请填写目标地址', 'error');
      dom.url.focus();
      return;
    }
    if (draft.body.trim() && (draft.method === 'GET' || draft.method === 'HEAD')) {
      showFieldError('body', `请求方式为 ${draft.method} 时不带请求内容，请清空请求内容或更换请求方式`);
      showNotice('请求方式与请求内容不匹配，请调整后再发送', 'error');
      return;
    }

    setBusy(true, 'send');
    renderResultPending(draft);
    try {
      const result = await request('/api/send', { method: 'POST', body: draft });
      state.result = result;
      renderResult(result);
      if (result.ok) {
        showNotice(`请求已完成：状态码 ${result.status}，耗时 ${formatDuration(result.timeMs)}`, 'success');
      } else {
        showNotice(`请求失败：${result.failure.reason}`, 'error');
      }
    } catch (err) {
      state.result = null;
      if (err.field) showFieldError(err.field, err.message);
      dom.resultSummary.textContent = '';
      dom.resultBody.textContent = '';
      dom.clearResult.hidden = false;
      dom.resultBody.appendChild(buildFailurePanel('这次请求没有发出去', err.message, ''));
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function renderResultPending(draft) {
    dom.resultSummary.textContent = '正在等待响应';
    dom.clearResult.hidden = true;
    dom.resultBody.textContent = '';

    const block = document.createElement('div');
    block.className = 'result-pending';
    const title = document.createElement('p');
    title.className = 'pending-title';
    title.textContent = '请求已发出，正在等待响应…';
    const sub = document.createElement('p');
    sub.className = 'empty-sub';
    sub.textContent = `${draft.method} ${draft.url} 已按照填写的内容发出去，收到回应后这里会显示状态、耗时、响应头与响应内容。`;
    block.append(title, sub);
    dom.resultBody.appendChild(block);
  }

  function renderEmptyResult() {
    dom.resultSummary.textContent = '';
    dom.clearResult.hidden = true;
    dom.resultBody.textContent = '';
    dom.resultBody.appendChild(
      buildEmptyBlock(
        '还没有发送过请求',
        '填好请求方式与目标地址后点「发送请求」，这里会显示响应状态、耗时、响应头与响应内容。'
      )
    );
  }

  function renderResult(result) {
    dom.resultBody.textContent = '';
    dom.clearResult.hidden = false;

    const head = document.createElement('div');
    head.className = 'result-head';

    if (result.ok) {
      head.appendChild(buildStatusBadge(result.status, result.statusText));
      head.appendChild(buildChip(`耗时 ${formatDuration(result.timeMs)}`));
      head.appendChild(buildChip(`内容 ${formatBytes(result.size)}`));
      // 状态码落在 400 及以上时，页面同样按失败口径提醒
      if (result.status >= 400) head.appendChild(buildChip('本次响应为失败状态', 'chip-bad'));
      dom.resultSummary.textContent = `最近一次：${result.status} ${result.statusText}`.trim();
    } else {
      head.appendChild(buildStatusBadge(0, '未完成'));
      head.appendChild(buildChip(`已等待 ${formatDuration(result.timeMs)}`));
      dom.resultSummary.textContent = '最近一次：请求未完成';
    }
    dom.resultBody.appendChild(head);

    const targetLine = document.createElement('p');
    targetLine.className = 'result-target';
    targetLine.textContent = result.internal
      ? `目标地址（本机内置示例接口）：${result.targetUrl}`
      : `目标地址：${result.targetUrl}`;
    dom.resultBody.appendChild(targetLine);

    if (!result.ok) {
      dom.resultBody.appendChild(
        buildFailurePanel('请求没有完成', result.failure.reason, result.failure.detail)
      );
      return;
    }

    const headerSection = buildSection('响应头');
    if (result.headers.length) {
      headerSection.appendChild(buildHeaderTable(result.headers));
    } else {
      headerSection.appendChild(buildTextNote('本次响应没有返回响应头'));
    }
    dom.resultBody.appendChild(headerSection);

    const bodySection = buildSection('响应内容');
    bodySection.appendChild(buildBodyView(result));
    dom.resultBody.appendChild(bodySection);
  }

  function buildFailurePanel(title, reason, detail) {
    const panel = document.createElement('div');
    panel.className = 'failure-panel';

    const titleNode = document.createElement('p');
    titleNode.className = 'failure-title';
    titleNode.textContent = title;

    const reasonNode = document.createElement('p');
    reasonNode.className = 'failure-reason';
    reasonNode.textContent = `失败原因：${reason}`;

    panel.append(titleNode, reasonNode);

    if (detail) {
      const detailNode = document.createElement('p');
      detailNode.className = 'failure-detail';
      detailNode.textContent = `详细信息：${detail}`;
      panel.appendChild(detailNode);
    }
    return panel;
  }

  function buildBodyView(result) {
    const wrap = document.createElement('div');
    wrap.className = 'body-view';

    const text = typeof result.body === 'string' ? result.body : '';
    if (!text.trim()) {
      wrap.appendChild(buildTextNote(result.status === 204 ? '本次响应为成功且没有返回内容' : '本次响应没有返回内容'));
      return wrap;
    }

    const tabs = document.createElement('div');
    tabs.className = 'view-tabs';
    tabs.append(
      buildTab('结构化', state.resultView === 'structured', () => switchResultView('structured')),
      buildTab('原始文本', state.resultView === 'raw', () => switchResultView('raw'))
    );
    wrap.appendChild(tabs);

    const parsed = tryParseJson(text);
    if (state.resultView === 'raw') {
      wrap.appendChild(buildPre(text));
    } else if (parsed.ok) {
      wrap.appendChild(buildJsonTree(parsed.value, '', { left: TREE_LIMIT }));
    } else {
      wrap.appendChild(buildTextNote('响应内容不是结构化数据，已按文本显示'));
      wrap.appendChild(buildPre(text));
    }

    if (result.truncated) {
      wrap.appendChild(buildTextNote('响应内容较大，这里只保留了开头的一部分用于展示'));
    }
    return wrap;
  }

  function switchResultView(view) {
    state.resultView = view;
    if (state.result) renderResult(state.result);
  }

  function tryParseJson(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (err) {
      return { ok: false, value: null };
    }
  }

  function buildPre(text) {
    const pre = document.createElement('pre');
    pre.className = 'result-pre';
    pre.textContent = text;
    return pre;
  }

  // 结构化视图：对象与数组逐层铺开，取值按类型区分显示
  function buildJsonTree(value, label, counter) {
    counter.left -= 1;
    const node = document.createElement('div');
    node.className = 'json-node';

    if (value !== null && typeof value === 'object') {
      const isArray = Array.isArray(value);
      const keys = isArray ? value.map((_, index) => index) : Object.keys(value);

      const head = document.createElement('div');
      head.className = 'json-line';
      head.appendChild(buildJsonKey(label));
      head.appendChild(buildJsonTag(`${isArray ? '数组' : '对象'} ${keys.length} 项`));
      node.appendChild(head);

      const children = document.createElement('div');
      children.className = 'json-children';

      if (!keys.length) {
        children.appendChild(buildJsonLine('', isArray ? '空数组' : '空对象', 'empty'));
      } else {
        let shown = 0;
        for (let index = 0; index < keys.length; index += 1) {
          if (counter.left <= 0) break;
          const key = keys[index];
          children.appendChild(
            buildJsonTree(value[key], isArray ? `[${key}]` : String(key), counter)
          );
          shown += 1;
        }
        if (shown < keys.length) {
          children.appendChild(buildTextNote(`还有 ${keys.length - shown} 项未展开，可切换到原始文本查看完整内容`));
        }
      }

      node.appendChild(children);
      return node;
    }

    node.appendChild(buildJsonLine(label, describePrimitive(value), primitiveKind(value)));
    return node;
  }

  function buildJsonLine(label, text, kind) {
    const line = document.createElement('div');
    line.className = 'json-line';
    if (label) line.appendChild(buildJsonKey(label));
    const valueNode = document.createElement('span');
    valueNode.className = `json-value json-${kind}`;
    valueNode.textContent = text;
    line.appendChild(valueNode);
    return line;
  }

  function buildJsonKey(label) {
    const key = document.createElement('span');
    key.className = 'json-key';
    key.textContent = label || '整体内容';
    return key;
  }

  function buildJsonTag(text) {
    const tag = document.createElement('span');
    tag.className = 'json-tag';
    tag.textContent = text;
    return tag;
  }

  function describePrimitive(value) {
    if (value === null) return 'null';
    if (typeof value === 'string') return `"${value}"`;
    return String(value);
  }

  function primitiveKind(value) {
    if (value === null) return 'null';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    return 'string';
  }

  // ---------------- 用例区 ----------------

  async function loadCases() {
    const list = await request('/api/cases');
    state.cases = Array.isArray(list) ? list : [];
    if (state.selectedId && !state.cases.some((item) => item.id === state.selectedId)) {
      state.selectedId = '';
    }
    renderCases();
    // 用例集合变化后，链路步骤里的用例下拉、来源说明与「用例缺失」标记也要跟着刷新
    if (state.chainDraft && state.chainDraft.steps.length) {
      renderChainSteps();
      scheduleChainPreview();
    }
  }

  function renderCases() {
    dom.caseSummary.textContent = `共 ${state.cases.length} 条`;
    dom.caseList.textContent = '';

    if (!state.cases.length) {
      dom.caseList.appendChild(
        buildEmptyBlock('还没有保存过用例', '在请求区填好内容后点「保存为用例」，用例会出现在这里。')
      );
      return;
    }
    state.cases.forEach((item) => {
      dom.caseList.appendChild(buildCaseRow(item));
    });
  }

  function buildEmptyBlock(title, subtitle) {
    const block = document.createElement('div');
    block.className = 'empty';
    const titleNode = document.createElement('p');
    titleNode.className = 'empty-title';
    titleNode.textContent = title;
    const subNode = document.createElement('p');
    subNode.className = 'empty-sub';
    subNode.textContent = subtitle;
    block.append(titleNode, subNode);
    return block;
  }

  function buildTextNote(text) {
    const note = document.createElement('p');
    note.className = 'text-note';
    note.textContent = text;
    return note;
  }

  function buildTag(text, kind) {
    const tag = document.createElement('span');
    tag.className = `method method-${kind || 'any'}`;
    tag.textContent = text;
    return tag;
  }

  function buildCaseRow(item) {
    const row = document.createElement('article');
    row.className = 'case-item';
    if (item.id === state.selectedId) row.classList.add('active');

    const main = document.createElement('div');
    main.className = 'case-main';

    const title = document.createElement('div');
    title.className = 'case-title';
    const nameNode = document.createElement('span');
    nameNode.className = 'case-name';
    nameNode.textContent = item.name;
    title.append(buildTag(item.method, String(item.method).toLowerCase()), nameNode);
    if (item.url.startsWith('/')) title.appendChild(buildTag('内置', 'inner'));

    const urlNode = document.createElement('p');
    urlNode.className = 'case-url';
    urlNode.textContent = item.url;

    const metaNode = document.createElement('p');
    metaNode.className = 'case-meta';
    metaNode.textContent = `请求头 ${item.headers.length} 行 · 保存于 ${formatTime(item.createdAt)}`;

    main.append(title, urlNode, metaNode);

    const actions = document.createElement('div');
    actions.className = 'case-actions';

    const fillButton = document.createElement('button');
    fillButton.type = 'button';
    fillButton.className = 'btn btn-small';
    fillButton.textContent = '回填';
    fillButton.addEventListener('click', () => {
      applyCase(item);
    });

    const viewButton = document.createElement('button');
    viewButton.type = 'button';
    viewButton.className = 'btn btn-small';
    viewButton.textContent = '详情';
    viewButton.addEventListener('click', () => {
      openDetail(item.id);
    });

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn btn-small btn-danger';
    deleteButton.textContent = '删除';
    deleteButton.addEventListener('click', () => {
      removeCase(item);
    });

    actions.append(fillButton, viewButton, deleteButton);
    row.append(main, actions);
    return row;
  }

  // 回填：把用例保存下来的内容写回请求区，可以直接点发送请求重发一次
  function applyCase(item) {
    if (state.busy) return;
    fillDraft(item);
    state.selectedId = item.id;
    renderCases();
    renderDetail(item);
    showNotice(`用例「${item.name}」已回填到请求区，可直接点发送请求`, 'success');
  }

  async function openDetail(id) {
    if (state.busy) return;
    try {
      const item = await request(`/api/cases/${encodeURIComponent(id)}`);
      state.selectedId = item.id;
      renderCases();
      renderDetail(item);
    } catch (err) {
      showNotice(err.message, 'error');
      if (err.code === 'CASE_NOT_FOUND') {
        state.selectedId = '';
        renderEmptyDetail();
        try {
          await loadCases();
        } catch (reloadError) {
          showNotice(reloadError.message, 'error');
        }
      }
    }
  }

  function renderDetail(item) {
    dom.caseDetail.textContent = '';

    const head = document.createElement('div');
    head.className = 'detail-head';
    const nameNode = document.createElement('h3');
    nameNode.textContent = item.name;
    head.append(buildTag(item.method, String(item.method).toLowerCase()), nameNode);

    const fillButton = document.createElement('button');
    fillButton.type = 'button';
    fillButton.className = 'btn btn-small';
    fillButton.textContent = '回填到请求区';
    fillButton.addEventListener('click', () => {
      applyCase(item);
    });
    head.appendChild(fillButton);

    dom.caseDetail.append(head);
    dom.caseDetail.append(buildDetailRow('目标地址', item.url, false));
    dom.caseDetail.append(
      buildDetailRow(
        '请求头',
        item.headers.length ? item.headers.map((row) => `${row.key}: ${row.value}`).join('\n') : '暂无内容',
        true
      )
    );
    dom.caseDetail.append(buildDetailRow('请求内容', item.body || '暂无内容', true));
    dom.caseDetail.append(
      buildDetailRow('保存时间', `${formatTime(item.createdAt)}（最近更新 ${formatTime(item.updatedAt)}）`, false)
    );
    dom.closeDetail.hidden = false;
  }

  function buildDetailRow(label, text, block) {
    const wrap = document.createElement('div');
    wrap.className = 'detail-row';

    const labelNode = document.createElement('span');
    labelNode.className = 'detail-label';
    labelNode.textContent = label;

    const valueNode = document.createElement(block ? 'pre' : 'p');
    valueNode.className = 'detail-value';
    valueNode.textContent = text;

    wrap.append(labelNode, valueNode);
    return wrap;
  }

  function renderEmptyDetail() {
    dom.closeDetail.hidden = true;
    dom.caseDetail.textContent = '';
    const subNode = document.createElement('p');
    subNode.className = 'empty-sub';
    subNode.textContent = emptyDetailHint;
    dom.caseDetail.appendChild(subNode);
  }

  // ---------------- 保存与删除 ----------------

  async function saveCase() {
    if (state.busy) return;
    clearFieldErrors();

    const draft = collectDraft();
    if (!draft.name) {
      showFieldError('name', '请填写用例名称');
      showNotice('请填写用例名称', 'error');
      dom.name.focus();
      return;
    }
    if (!draft.url) {
      showFieldError('url', '请填写目标地址');
      showNotice('请填写目标地址', 'error');
      dom.url.focus();
      return;
    }

    setBusy(true, 'save');
    try {
      const created = await request('/api/cases', { method: 'POST', body: draft });
      state.selectedId = created.id;
      await loadCases();
      renderDetail(created);
      showNotice(`用例「${created.name}」已保存，请求区内容保留可直接发送`, 'success');
    } catch (err) {
      if (err.field) showFieldError(err.field, err.message);
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removeCase(item) {
    if (state.busy) return;
    const confirmed = window.confirm(`确认删除用例「${item.name}」？删除后无法恢复。`);
    if (!confirmed) return;

    setBusy(true);
    try {
      await request(`/api/cases/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      if (state.selectedId === item.id) state.selectedId = '';
      await loadCases();
      if (!state.selectedId) renderEmptyDetail();
      showNotice(`用例「${item.name}」已删除`, 'success');
    } catch (err) {
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  // ---------------- 链路区 ----------------

  async function loadChains() {
    const list = await request('/api/chains');
    state.chains = Array.isArray(list) ? list : [];
    renderChainPicker();
    if (state.chainSavedId && !state.chains.some((item) => item.id === state.chainSavedId)) {
      state.chainSavedId = '';
    }
  }

  function caseById(id) {
    return state.cases.find((item) => item.id === id) || null;
  }

  // 已保存链路与页面草稿的结构可能缺字段，统一补齐再渲染/提交
  function normalizeDraftStep(step) {
    const source = step && typeof step === 'object' ? step : {};
    return {
      id: source.id || uid('step'),
      caseId: typeof source.caseId === 'string' ? source.caseId : '',
      enabled: source.enabled !== false,
      bindings: Array.isArray(source.bindings) ? source.bindings.map((item) => ({
        id: item.id || uid('bind'),
        target: ['url', 'header', 'body'].includes(item.target) ? item.target : 'url',
        headerKey: typeof item.headerKey === 'string' ? item.headerKey : '',
        path: typeof item.path === 'string' ? item.path : '',
        sourceStepId: typeof item.sourceStepId === 'string' ? item.sourceStepId : '',
        valuePath: typeof item.valuePath === 'string' ? item.valuePath : '',
      })) : [],
    };
  }

  function chainFromServer(chain) {
    return {
      id: chain.id,
      name: chain.name || '',
      steps: Array.isArray(chain.steps) ? chain.steps.map(normalizeDraftStep) : [],
    };
  }

  function collectChainPayload() {
    return {
      name: dom.chainName.value.trim(),
      steps: state.chainDraft.steps.map((step) => ({
        id: step.id,
        caseId: step.caseId,
        enabled: step.enabled,
        bindings: step.bindings.map((binding) => ({
          id: binding.id,
          target: binding.target,
          headerKey: binding.headerKey,
          path: binding.path.trim(),
          sourceStepId: binding.sourceStepId,
          valuePath: binding.valuePath.trim(),
        })),
      })),
    };
  }

  function renderChainPicker() {
    const current = state.chainSavedId;
    dom.chainPicker.textContent = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = state.chains.length ? '选择已保存的链路…' : '还没有保存过链路';
    dom.chainPicker.appendChild(placeholder);
    state.chains.forEach((chain) => {
      const option = document.createElement('option');
      option.value = chain.id;
      option.textContent = chain.name;
      dom.chainPicker.appendChild(option);
    });
    dom.chainPicker.value = current || '';
  }

  function loadChainIntoEditor(chain) {
    state.chainDraft = chainFromServer(chain);
    state.chainSavedId = chain.id;
    dom.chainName.value = chain.name;
    dom.chainPicker.value = chain.id;
    renderChainSteps();
    refreshChainPreview();
    hideChainError();
  }

  function newChainEditor() {
    state.chainDraft = emptyChainDraft();
    state.chainSavedId = '';
    dom.chainName.value = '';
    dom.chainPicker.value = '';
    state.chainResult = null;
    dom.chainResultPanel.hidden = true;
    addChainStep();
    hideChainError();
  }

  function addChainStep() {
    state.chainDraft.steps.push(normalizeDraftStep({ id: uid('step'), enabled: true, bindings: [] }));
    renderChainSteps();
    scheduleChainPreview();
  }

  function moveChainStep(index, delta) {
    const target = index + delta;
    const steps = state.chainDraft.steps;
    if (target < 0 || target >= steps.length) return;
    const [item] = steps.splice(index, 1);
    steps.splice(target, 0, item);
    renderChainSteps();
    scheduleChainPreview();
  }

  function removeChainStep(index) {
    state.chainDraft.steps.splice(index, 1);
    renderChainSteps();
    scheduleChainPreview();
  }

  function toggleChainStep(index) {
    const step = state.chainDraft.steps[index];
    step.enabled = !step.enabled;
    renderChainSteps();
    scheduleChainPreview();
  }

  function addBinding(index) {
    state.chainDraft.steps[index].bindings.push(emptyBinding());
    renderChainSteps();
    scheduleChainPreview();
  }

  function removeBinding(stepIndex, bindIndex) {
    state.chainDraft.steps[stepIndex].bindings.splice(bindIndex, 1);
    renderChainSteps();
    scheduleChainPreview();
  }

  function renderChainSteps() {
    const steps = state.chainDraft.steps;
    dom.chainSteps.textContent = '';
    dom.chainHint.textContent = steps.length
      ? `共 ${steps.length} 步，启用 ${steps.filter((s) => s.enabled).length} 步`
      : '';

    if (!steps.length) {
      const empty = document.createElement('p');
      empty.className = 'rows-empty';
      empty.textContent = '链路还是空的，点「添加一步」从用例里挑一条开始。';
      dom.chainSteps.appendChild(empty);
      return;
    }

    steps.forEach((step, index) => {
      dom.chainSteps.appendChild(buildChainStepCard(step, index));
    });
  }

  function buildChainStepCard(step, index) {
    const ordinal = index + 1;
    const card = document.createElement('div');
    card.className = 'chain-step';
    if (!step.enabled) card.classList.add('is-off');

    const head = document.createElement('div');
    head.className = 'chain-step-head';

    const ord = document.createElement('span');
    ord.className = 'chain-step-ord';
    ord.textContent = `第 ${ordinal} 步`;

    const caseSelect = document.createElement('select');
    caseSelect.className = 'chain-case-select';
    caseSelect.dataset.role = 'case';
    caseSelect.dataset.index = String(index);
    const please = document.createElement('option');
    please.value = '';
    please.textContent = '选择已保存的用例';
    caseSelect.appendChild(please);
    state.cases.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = `${item.method} ${item.name}`;
      caseSelect.appendChild(option);
    });
    caseSelect.value = step.caseId;

    const missingTag = step.caseId && !caseById(step.caseId)
      ? buildTag('用例缺失', 'delete')
      : null;

    const tools = document.createElement('div');
    tools.className = 'chain-step-tools';
    tools.appendChild(buildToolButton('上移', 'up', index, index === 0));
    tools.appendChild(buildToolButton('下移', 'down', index, index === state.chainDraft.steps.length - 1));
    const toggleBtn = buildToolButton(step.enabled ? '跳过' : '放回', 'toggle', index, false);
    if (!step.enabled) toggleBtn.classList.add('btn-primary');
    tools.appendChild(toggleBtn);
    tools.appendChild(buildToolButton('移除', 'remove', index, false, true));

    head.append(ord, caseSelect);
    if (missingTag) head.appendChild(missingTag);
    head.appendChild(tools);
    card.appendChild(head);

    if (step.enabled) {
      const binds = document.createElement('div');
      binds.className = 'chain-binds';
      if (!step.bindings.length) {
        const none = document.createElement('p');
        none.className = 'rows-empty';
        none.textContent = '本步不取值，直接按用例原样发送。';
        binds.appendChild(none);
      } else {
        step.bindings.forEach((binding, bindIndex) => {
          binds.appendChild(buildBindingRow(step, binding, index, bindIndex, ordinal));
        });
      }
      const addBind = document.createElement('button');
      addBind.type = 'button';
      addBind.className = 'btn btn-ghost btn-small';
      addBind.textContent = '添加一个取值';
      addBind.dataset.act = 'add-binding';
      addBind.dataset.index = String(index);
      binds.appendChild(addBind);
      card.appendChild(binds);
    } else {
      const off = document.createElement('p');
      off.className = 'chain-off-note';
      off.textContent = '这一步已被临时跳过，不会发送，也不能作为后面步骤的取值来源。';
      card.appendChild(off);
    }

    return card;
  }

  function buildToolButton(text, act, index, disabled, danger) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn btn-small${danger ? ' btn-danger' : ''}`;
    button.textContent = text;
    button.dataset.act = act;
    button.dataset.index = String(index);
    button.disabled = !!disabled;
    return button;
  }

  // 一个取值绑定：从来源步骤的响应路径取值，注入到本步的指定位置
  function buildBindingRow(step, binding, stepIndex, bindIndex, ordinal) {
    const row = document.createElement('div');
    row.className = 'chain-bind';

    const common = (node, role) => {
      node.dataset.role = role;
      node.dataset.index = String(stepIndex);
      node.dataset.bind = String(bindIndex);
      return node;
    };

    const fromLabel = document.createElement('span');
    fromLabel.className = 'chain-bind-word';
    fromLabel.textContent = '从第';

    // 来源步骤只列出排在本步之前的步骤，跳过的步骤置灰不可选
    const sourceSelect = common(document.createElement('select'), 'source');
    const srcPlease = document.createElement('option');
    srcPlease.value = '';
    srcPlease.textContent = '步骤';
    sourceSelect.appendChild(srcPlease);
    state.chainDraft.steps.forEach((candidate, candidateIndex) => {
      if (candidateIndex >= stepIndex) return;
      const option = document.createElement('option');
      option.value = candidate.id;
      const useCase = caseById(candidate.caseId);
      option.textContent = `${candidateIndex + 1} 步${useCase ? ` · ${useCase.name}` : ' · 用例缺失'}`;
      option.disabled = !candidate.enabled || !candidate.caseId;
      sourceSelect.appendChild(option);
    });
    sourceSelect.value = binding.sourceStepId;
    if (binding.sourceStepId && !Array.from(sourceSelect.options).some((o) => o.value === binding.sourceStepId && !o.disabled)) {
      const broken = document.createElement('option');
      broken.value = binding.sourceStepId;
      broken.textContent = '来源不可用';
      sourceSelect.appendChild(broken);
      sourceSelect.value = binding.sourceStepId;
    }

    const fromLabel2 = document.createElement('span');
    fromLabel2.className = 'chain-bind-word';
    fromLabel2.textContent = '步响应的';

    const valuePath = common(document.createElement('input'), 'valuePath');
    valuePath.type = 'text';
    valuePath.className = 'chain-input chain-input-path';
    valuePath.placeholder = '取值路径，如 items[0].id';
    valuePath.value = binding.valuePath;
    valuePath.autocomplete = 'off';
    valuePath.spellcheck = false;

    const injectLabel = document.createElement('span');
    injectLabel.className = 'chain-bind-word';
    injectLabel.textContent = '注入到本步';

    const targetSelect = common(document.createElement('select'), 'target');
    [['url', '地址查询参数'], ['header', '某行请求头'], ['body', 'JSON 请求内容']].forEach(([value, text]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      targetSelect.appendChild(option);
    });
    targetSelect.value = binding.target;

    // 注入位置控件随目标类型变化
    const placeWrap = document.createElement('span');
    placeWrap.className = 'chain-bind-place';
    const useCase = caseById(step.caseId);
    if (binding.target === 'header') {
      const headerSelect = common(document.createElement('select'), 'headerKey');
      const hPlease = document.createElement('option');
      hPlease.value = '';
      hPlease.textContent = '选择请求头';
      headerSelect.appendChild(hPlease);
      (useCase ? useCase.headers : []).forEach((h) => {
        const option = document.createElement('option');
        option.value = h.key;
        option.textContent = h.key;
        headerSelect.appendChild(option);
      });
      headerSelect.value = binding.headerKey;
      placeWrap.appendChild(headerSelect);
    } else {
      const placeInput = common(document.createElement('input'), 'path');
      placeInput.type = 'text';
      placeInput.className = 'chain-input';
      placeInput.placeholder = binding.target === 'url' ? '查询参数名，如 orderId' : '内容位置，如 orderId 或 user.id';
      placeInput.value = binding.path;
      placeInput.autocomplete = 'off';
      placeInput.spellcheck = false;
      placeWrap.appendChild(placeInput);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-ghost btn-small btn-danger';
    remove.textContent = '删除取值';
    remove.dataset.act = 'remove-binding';
    remove.dataset.index = String(stepIndex);
    remove.dataset.bind = String(bindIndex);

    row.append(fromLabel, sourceSelect, fromLabel2, valuePath, injectLabel, targetSelect, placeWrap, remove);
    return row;
  }

  // ---------------- 链路预览 ----------------

  function scheduleChainPreview() {
    window.clearTimeout(state.chainPreviewTimer);
    state.chainPreviewTimer = window.setTimeout(refreshChainPreview, 250);
  }

  async function refreshChainPreview() {
    const payload = collectChainPayload();
    if (!payload.steps.length) {
      state.chainPreview = [];
      renderChainPreview();
      return;
    }
    try {
      const data = await request('/api/chains/preview', { method: 'POST', body: payload });
      state.chainPreview = Array.isArray(data.steps) ? data.steps : [];
      hideChainError();
      renderChainPreview();
    } catch (err) {
      state.chainPreview = [];
      showChainError(err.message);
      renderChainPreview();
    }
  }

  function showChainError(message) {
    dom.chainError.textContent = message;
    dom.chainError.hidden = false;
  }

  function hideChainError() {
    dom.chainError.textContent = '';
    dom.chainError.hidden = true;
  }

  // 把 {{@step=N@path}} 占位符渲染成带来源说明的高亮片段
  const TOKEN_RE = /\{\{@step=(\d+)@([^}]*?)\}\}/g;
  function fragmentWithTokens(text) {
    const fragment = document.createDocumentFragment();
    const content = String(text == null ? '' : text);
    let last = 0;
    let match = null;
    TOKEN_RE.lastIndex = 0;
    while ((match = TOKEN_RE.exec(content)) !== null) {
      if (match.index > last) fragment.appendChild(document.createTextNode(content.slice(last, match.index)));
      const token = document.createElement('span');
      token.className = 'chain-token';
      token.title = `这个值在发送时取自第 ${match[1]} 步响应里的 ${match[2]}`;
      token.textContent = `〔取自第 ${match[1]} 步 · ${match[2]}〕`;
      fragment.appendChild(token);
      last = TOKEN_RE.lastIndex;
    }
    fragment.appendChild(document.createTextNode(content.slice(last)));
    return fragment;
  }

  function renderChainPreview() {
    dom.chainPreview.textContent = '';
    if (!state.chainPreview.length) {
      const note = document.createElement('p');
      note.className = 'empty-sub';
      note.textContent = '链路配置无误后，这里按执行顺序列出每一步实际会发出的方法、地址、请求头与请求内容；取值位置会高亮并标明来源。';
      dom.chainPreview.appendChild(note);
      return;
    }

    state.chainPreview.forEach((preview) => {
      const block = document.createElement('div');
      block.className = 'preview-step';
      if (!preview.enabled) block.classList.add('is-off');

      const title = document.createElement('div');
      title.className = 'preview-step-title';
      title.append(buildTag(preview.method, String(preview.method).toLowerCase()));
      const titleText = document.createElement('span');
      titleText.textContent = `第 ${preview.ordinal} 步 · ${preview.caseName}${preview.enabled ? '' : '（已跳过）'}`;
      title.appendChild(titleText);
      block.appendChild(title);

      if (!preview.enabled) {
        dom.chainPreview.appendChild(block);
        return;
      }

      const urlLine = document.createElement('p');
      urlLine.className = 'preview-line preview-url';
      urlLine.appendChild(fragmentWithTokens(preview.url));
      block.appendChild(urlLine);

      if (preview.injections.length) {
        const mark = document.createElement('p');
        mark.className = 'preview-injects';
        preview.injections.forEach((inj, i) => {
          if (i) mark.appendChild(document.createTextNode('；'));
          const where = inj.target === 'url'
            ? `地址参数「${inj.path}」`
            : inj.target === 'header'
              ? `请求头「${inj.headerKey}」`
              : `内容「${inj.path}」`;
          mark.appendChild(document.createTextNode(`${where} ← 第 ${inj.sourceOrdinal} 步响应 ${inj.valuePath}`));
        });
        block.appendChild(mark);
      }

      if (preview.headers.length) {
        const headerWrap = document.createElement('div');
        headerWrap.className = 'preview-headers';
        preview.headers.forEach((h) => {
          const line = document.createElement('div');
          line.className = 'preview-header-line';
          const key = document.createElement('span');
          key.className = 'preview-header-key';
          key.textContent = `${h.key}:`;
          const value = document.createElement('span');
          value.className = 'preview-header-value';
          value.appendChild(fragmentWithTokens(h.value));
          line.append(key, value);
          headerWrap.appendChild(line);
        });
        block.appendChild(headerWrap);
      }

      if (preview.body) {
        const pre = document.createElement('pre');
        pre.className = 'preview-body';
        pre.appendChild(fragmentWithTokens(preview.body));
        block.appendChild(pre);
      }

      dom.chainPreview.appendChild(block);
    });
  }

  // ---------------- 链路保存 / 删除 / 执行 ----------------

  function setChainBusy(busy, action) {
    state.chainBusy = busy;
    [dom.chainRun, dom.chainSave, dom.chainDelete, dom.chainNew, dom.chainAddStep, dom.chainPicker].forEach((node) => {
      node.disabled = busy;
    });
    dom.chainRun.textContent = busy && action === 'run' ? '正在依次发送…' : '依次发送链路';
    dom.chainSave.textContent = busy && action === 'save' ? '正在保存…' : '保存链路';
  }

  async function saveChain() {
    if (state.chainBusy) return;
    const payload = collectChainPayload();
    if (!payload.name) {
      showChainError('请先在上方填写链路名称再保存。');
      dom.chainName.focus();
      return;
    }
    setChainBusy(true, 'save');
    try {
      let saved = null;
      if (state.chainSavedId) {
        saved = await request(`/api/chains/${encodeURIComponent(state.chainSavedId)}`, { method: 'PUT', body: payload });
      } else {
        saved = await request('/api/chains', { method: 'POST', body: payload });
      }
      state.chainDraft = chainFromServer(saved);
      state.chainSavedId = saved.id;
      await loadChains();
      dom.chainPicker.value = saved.id;
      renderChainSteps();
      await refreshChainPreview();
      showNotice(`链路「${saved.name}」已保存`, 'success');
    } catch (err) {
      showChainError(err.message);
    } finally {
      setChainBusy(false);
    }
  }

  async function deleteChain() {
    if (state.chainBusy) return;
    if (!state.chainSavedId) {
      showChainError('当前是尚未保存的新链路，直接点「新建」清空即可。');
      return;
    }
    const name = dom.chainName.value.trim() || '这条链路';
    const confirmed = window.confirm(`确认删除链路「${name}」？链路里引用的用例不会被删除。`);
    if (!confirmed) return;
    setChainBusy(true, 'delete');
    try {
      await request(`/api/chains/${encodeURIComponent(state.chainSavedId)}`, { method: 'DELETE' });
      showNotice(`链路「${name}」已删除，引用的用例保留不动`, 'success');
      state.chainSavedId = '';
      await loadChains();
      newChainEditor();
    } catch (err) {
      showChainError(err.message);
    } finally {
      setChainBusy(false);
    }
  }

  async function runChain() {
    if (state.chainBusy) return;
    const payload = collectChainPayload();
    if (!payload.steps.length) {
      showChainError('链路里还没有任何步骤，先添加一步再发送。');
      return;
    }
    setChainBusy(true, 'run');
    state.chainResult = null;
    renderChainResult();
    try {
      const report = await request('/api/chains/run', { method: 'POST', body: payload });
      state.chainResult = report;
      renderChainResult();
      if (report.ok) {
        showNotice(`链路全部完成，共发送 ${report.results.length} 步`, 'success');
      } else {
        showChainError(report.reason || '链路在某一步停止了');
        showNotice(report.reason || '链路已停止', 'error');
      }
    } catch (err) {
      showChainError(err.message);
      showNotice(err.message, 'error');
    } finally {
      setChainBusy(false);
    }
  }

  function renderChainResult() {
    const report = state.chainResult;
    dom.chainResultPanel.hidden = !report;
    if (!report) return;
    dom.chainResult.textContent = '';

    const summary = document.createElement('p');
    summary.className = report.ok ? 'chain-result-ok' : 'chain-result-bad';
    summary.textContent = report.ok
      ? `全部 ${report.results.length} 步发送成功。`
      : `链路在执行第 ${report.stoppedAt} 步时停止：${report.reason}`;
    dom.chainResult.appendChild(summary);

    report.results.forEach((entry) => {
      const block = document.createElement('div');
      block.className = 'result-stepcard';
      const head = document.createElement('div');
      head.className = 'preview-step-title';
      head.appendChild(buildStatusBadge(entry.result.ok ? entry.result.status : 0, entry.result.ok ? entry.result.statusText : '未完成'));
      const text = document.createElement('span');
      text.textContent = `执行第 ${entry.ordinal} 步（编辑区第 ${entry.stepOrdinal} 步）· ${entry.caseName} · ${formatDuration(entry.result.timeMs)}`;
      head.appendChild(text);
      block.appendChild(head);

      const urlLine = document.createElement('p');
      urlLine.className = 'preview-line preview-url';
      urlLine.textContent = entry.draft.url;
      block.appendChild(urlLine);

      if (entry.injections.length) {
        const mark = document.createElement('p');
        mark.className = 'preview-injects';
        entry.injections.forEach((inj, i) => {
          if (i) mark.appendChild(document.createTextNode('；'));
          mark.appendChild(document.createTextNode(
            `${inj.target === 'url' ? `参数「${inj.path}」` : inj.target === 'header' ? `请求头「${inj.headerKey}」` : `内容「${inj.path}」`} = ${inj.value}（来自第 ${inj.sourceOrdinal} 步 ${inj.valuePath}）`
          ));
        });
        block.appendChild(mark);
      }

      if (!entry.result.ok) {
        block.appendChild(buildFailurePanel('这一步没有完成', entry.result.failure.reason, entry.result.failure.detail));
      }
      dom.chainResult.appendChild(block);
    });
  }

  // ---------------- 结果区小零件 ----------------

  function buildSection(title) {
    const section = document.createElement('div');
    section.className = 'result-section';
    const head = document.createElement('p');
    head.className = 'result-section-title';
    head.textContent = title;
    section.appendChild(head);
    return section;
  }

  function buildStatusBadge(code, statusText) {
    const badge = document.createElement('span');
    badge.className = 'status-badge';
    if (!code) {
      badge.classList.add('status-bad');
    } else if (code >= 500) {
      badge.classList.add('status-bad');
    } else if (code >= 400) {
      badge.classList.add('status-warn');
    } else if (code >= 300) {
      badge.classList.add('status-info');
    } else {
      badge.classList.add('status-ok');
    }
    badge.textContent = code ? `${code} ${statusText}`.trim() : statusText;
    return badge;
  }

  function buildChip(text, extraClass) {
    const chip = document.createElement('span');
    chip.className = extraClass ? `chip ${extraClass}` : 'chip';
    chip.textContent = text;
    return chip;
  }

  function buildTab(text, active, onClick) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = active ? 'view-tab active' : 'view-tab';
    tab.textContent = text;
    tab.addEventListener('click', onClick);
    return tab;
  }

  function buildHeaderTable(headers) {
    const list = document.createElement('div');
    list.className = 'header-table';
    headers.forEach((row) => {
      const line = document.createElement('div');
      line.className = 'header-line';
      const keyNode = document.createElement('span');
      keyNode.className = 'header-line-key';
      keyNode.textContent = row.key;
      const valueNode = document.createElement('span');
      valueNode.className = 'header-line-value';
      valueNode.textContent = row.value;
      line.append(keyNode, valueNode);
      list.appendChild(line);
    });
    return list;
  }

  // ---------------- 工具函数 ----------------

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '时间未知';
    const pad = (num) => String(num).padStart(2, '0');
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
  }

  function formatDuration(ms) {
    const value = Number(ms) || 0;
    if (value >= 1000) return `${(value / 1000).toFixed(2)} 秒`;
    return `${value} 毫秒`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} 字节`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(2)} MB`;
  }

  async function checkHealth() {
    try {
      await request('/api/health');
      dom.health.textContent = '服务已连接';
      dom.health.classList.add('ok');
    } catch (err) {
      dom.health.textContent = '服务未连接';
      dom.health.classList.add('bad');
    }
  }

  // ---------------- 事件绑定与入口 ----------------

  function bindEvents() {
    dom.headerRows.addEventListener('input', (event) => {
      const target = event.target;
      const index = Number(target.dataset ? target.dataset.index : NaN);
      const part = target.dataset ? target.dataset.part : '';
      if (!Number.isInteger(index) || !state.headers[index] || !part) return;
      state.headers[index][part] = target.value;
      const slot = document.querySelector('[data-error="headers"]');
      if (slot) slot.hidden = true;
      dom.headerRows.classList.remove('invalid');
    });

    dom.headerRows.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action="remove-header"]');
      if (!button) return;
      const index = Number(button.dataset.index);
      if (!Number.isInteger(index) || !state.headers[index]) return;
      state.headers.splice(index, 1);
      renderHeaderRows();
    });

    dom.addHeader.addEventListener('click', () => {
      state.headers.push({ key: '', value: '' });
      renderHeaderRows();
      const inputs = dom.headerRows.querySelectorAll('input');
      const last = inputs[inputs.length - 2];
      if (last) last.focus();
    });

    dom.sendRequest.addEventListener('click', sendRequest);
    dom.saveCase.addEventListener('click', saveCase);

    dom.resetDraft.addEventListener('click', () => {
      if (state.busy) return;
      resetDraft(false);
    });

    dom.clearResult.addEventListener('click', () => {
      state.result = null;
      renderEmptyResult();
      showNotice('结果区已清空', 'info');
    });

    dom.refreshCases.addEventListener('click', async () => {
      if (state.busy) return;
      try {
        await loadCases();
        showNotice('用例列表已刷新', 'info');
      } catch (err) {
        showNotice(err.message, 'error');
      }
    });

    dom.closeDetail.addEventListener('click', () => {
      state.selectedId = '';
      renderCases();
      renderEmptyDetail();
    });

    // ---------- 链路区 ----------

    dom.chainPicker.addEventListener('change', () => {
      if (state.chainBusy) return;
      const id = dom.chainPicker.value;
      if (!id) return;
      const chain = state.chains.find((item) => item.id === id);
      if (chain) loadChainIntoEditor(chain);
    });

    dom.chainName.addEventListener('input', () => {
      state.chainDraft.name = dom.chainName.value;
    });

    dom.chainNew.addEventListener('click', () => {
      if (state.chainBusy) return;
      newChainEditor();
    });

    dom.chainSave.addEventListener('click', saveChain);
    dom.chainDelete.addEventListener('click', deleteChain);
    dom.chainAddStep.addEventListener('click', () => {
      if (state.chainBusy) return;
      addChainStep();
    });
    dom.chainRun.addEventListener('click', runChain);

    dom.chainClearResult.addEventListener('click', () => {
      state.chainResult = null;
      dom.chainResultPanel.hidden = true;
    });

    // 步骤上的按钮统一用 data-act 委托
    dom.chainSteps.addEventListener('click', (event) => {
      if (state.chainBusy) return;
      const button = event.target.closest('button[data-act]');
      if (!button || !dom.chainSteps.contains(button)) return;
      const index = Number(button.dataset.index);
      if (!Number.isInteger(index)) return;
      switch (button.dataset.act) {
        case 'up':
          moveChainStep(index, -1);
          break;
        case 'down':
          moveChainStep(index, 1);
          break;
        case 'toggle':
          toggleChainStep(index);
          break;
        case 'remove':
          removeChainStep(index);
          break;
        case 'add-binding':
          addBinding(index);
          break;
        case 'remove-binding': {
          const bindIndex = Number(button.dataset.bind);
          if (Number.isInteger(bindIndex)) removeBinding(index, bindIndex);
          break;
        }
        default:
          break;
      }
    });

    // 用例选择、来源选择、注入目标属于 change；文本输入属于 input
    dom.chainSteps.addEventListener('change', (event) => {
      if (state.chainBusy) return;
      const node = event.target;
      const role = node.dataset ? node.dataset.role : '';
      if (!role) return;
      const index = Number(node.dataset.index);
      if (!Number.isInteger(index) || !state.chainDraft.steps[index]) return;
      const step = state.chainDraft.steps[index];

      if (role === 'case') {
        step.caseId = node.value;
        // 换用例后请求头绑定可能失效，渲染时让用户重新挑；其余绑定保留
        renderChainSteps();
        scheduleChainPreview();
        return;
      }

      const bindIndex = Number(node.dataset.bind);
      const binding = step.bindings[bindIndex];
      if (!binding) return;
      if (role === 'source') binding.sourceStepId = node.value;
      if (role === 'target') {
        binding.target = node.value;
        // 切换注入目标后位置控件类型会变，重新渲染整行
        renderChainSteps();
      }
      if (role === 'headerKey') binding.headerKey = node.value;
      scheduleChainPreview();
    });

    dom.chainSteps.addEventListener('input', (event) => {
      const node = event.target;
      const role = node.dataset ? node.dataset.role : '';
      if (role !== 'valuePath' && role !== 'path') return;
      const index = Number(node.dataset.index);
      const bindIndex = Number(node.dataset.bind);
      const binding = state.chainDraft.steps[index] && state.chainDraft.steps[index].bindings[bindIndex];
      if (!binding) return;
      if (role === 'valuePath') binding.valuePath = node.value;
      if (role === 'path') binding.path = node.value;
      scheduleChainPreview();
    });
  }

  async function init() {
    bindEvents();
    renderHeaderRows();
    renderEmptyDetail();
    renderEmptyResult();
    renderCases();
    renderChainSteps();
    renderChainPreview();
    await checkHealth();
    await loadDemos();
    try {
      await loadCases();
    } catch (err) {
      showNotice(err.message, 'error');
    }
    try {
      await loadChains();
    } catch (err) {
      showNotice(err.message, 'error');
    }
    // 默认进入新建链路编辑态，添加一个空步骤方便直接开始
    newChainEditor();
  }

  init();
})();
