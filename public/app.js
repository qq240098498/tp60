(function () {
  'use strict';

  // 页面状态：用例列表、内置示例接口、请求头草稿行、最近一次响应结果与结果视图，
  // 以及链路区的编辑状态（当前链路、步骤列表、运行结果）
  const state = {
    cases: [],
    selectedId: '',
    headers: [{ key: '', value: '' }],
    demos: [],
    busy: false,
    result: null,
    resultView: 'structured',
    chains: [],
    chainId: '',
    chainSteps: [],
    chainRun: null,
    chainBusy: false,
  };

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
    chainSelect: document.getElementById('chain-select'),
    chainSummary: document.getElementById('chain-summary'),
    refreshChains: document.getElementById('refresh-chains'),
    newChain: document.getElementById('new-chain'),
    deleteChain: document.getElementById('delete-chain'),
    chainName: document.getElementById('chain-name'),
    chainSteps: document.getElementById('chain-steps'),
    addStep: document.getElementById('add-step'),
    runChain: document.getElementById('run-chain'),
    saveChain: document.getElementById('save-chain'),
    chainPreview: document.getElementById('chain-preview'),
    chainRun: document.getElementById('chain-run'),
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

  // 步骤与注入规则的前端编号：保存时原样交给服务端，规则里的「从哪一步取」靠它引用
  let chainUidSeq = 0;
  function nextChainUid(prefix) {
    chainUidSeq += 1;
    return `${prefix}-${Date.now().toString(36)}-${chainUidSeq}`;
  }

  function createEmptyStep() {
    return { uid: nextChainUid('step'), caseId: '', skipped: false, extracts: [] };
  }

  function createEmptyExtract() {
    return { uid: nextChainUid('ex'), key: '', fromStep: '', path: '' };
  }

  function setChainBusy(busy, action) {
    state.chainBusy = busy;
    dom.runChain.disabled = busy;
    dom.saveChain.disabled = busy;
    dom.addStep.disabled = busy;
    dom.newChain.disabled = busy;
    dom.chainSelect.disabled = busy;
    dom.deleteChain.disabled = busy || !state.chainId;
    dom.runChain.textContent = busy && action === 'run' ? '运行中…' : '运行链路';
    dom.saveChain.textContent = busy && action === 'save' ? '正在保存…' : '保存链路';
  }

  async function loadChains() {
    const list = await request('/api/chains');
    state.chains = Array.isArray(list) ? list : [];
    renderChainSelect();
  }

  function renderChainSelect() {
    dom.chainSelect.textContent = '';
    dom.chainSelect.add(new Option('新建链路（未保存）', ''));
    state.chains.forEach((item) => {
      dom.chainSelect.add(new Option(item.name, item.id));
    });
    dom.chainSelect.value = state.chainId;
    dom.chainSummary.textContent = `共 ${state.chains.length} 条`;
    dom.deleteChain.disabled = state.chainBusy || !state.chainId;
  }

  function startNewChain() {
    state.chainId = '';
    dom.chainName.value = '';
    state.chainSteps = [createEmptyStep()];
    state.chainRun = null;
    dom.chainRun.textContent = '';
    renderChainSelect();
    renderChainSteps();
    renderChainErrors([]);
    renderChainPreview();
  }

  // 打开一条已保存的链路：以服务端保存下来的内容为准写回编辑区
  function loadChainIntoEditor(chain) {
    state.chainId = chain.id;
    dom.chainName.value = chain.name || '';
    state.chainSteps = (Array.isArray(chain.steps) ? chain.steps : []).map((step) => ({
      uid: step.id || nextChainUid('step'),
      caseId: typeof step.caseId === 'string' ? step.caseId : '',
      skipped: step.skipped === true,
      extracts: (Array.isArray(step.extracts) ? step.extracts : []).map((rule) => ({
        uid: rule.id || nextChainUid('ex'),
        key: typeof rule.key === 'string' ? rule.key : '',
        fromStep: typeof rule.fromStep === 'string' ? rule.fromStep : '',
        path: typeof rule.path === 'string' ? rule.path : '',
      })),
    }));
    state.chainRun = null;
    dom.chainRun.textContent = '';
    renderChainSelect();
    renderChainSteps();
    renderChainErrors(validateChainLocal());
    renderChainPreview();
  }

  // ---------------- 链路步骤编辑 ----------------

  function renderChainSteps() {
    dom.chainSteps.textContent = '';
    if (!state.chainSteps.length) {
      const empty = document.createElement('p');
      empty.className = 'rows-empty';
      empty.textContent = '还没有步骤，点「添加步骤」开始串联';
      dom.chainSteps.appendChild(empty);
      return;
    }
    state.chainSteps.forEach((step, index) => {
      dom.chainSteps.appendChild(buildStepCard(step, index));
    });
  }

  function stepOpButton(text, action, index, disabled) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-ghost btn-small';
    button.textContent = text;
    button.dataset.action = action;
    button.dataset.index = String(index);
    button.disabled = disabled;
    return button;
  }

  function buildStepCard(step, index) {
    const card = document.createElement('article');
    card.className = 'chain-step';
    if (step.skipped) card.classList.add('skipped');
    card.dataset.stepUid = step.uid;

    const head = document.createElement('div');
    head.className = 'chain-step-head';
    const title = document.createElement('span');
    title.className = 'chain-step-title';
    title.textContent = `第 ${index + 1} 步`;
    head.appendChild(title);
    if (step.skipped) head.appendChild(buildTag('已跳过', 'any'));

    const ops = document.createElement('div');
    ops.className = 'chain-step-ops';
    ops.append(
      stepOpButton('上移', 'move-up', index, index === 0),
      stepOpButton('下移', 'move-down', index, index === state.chainSteps.length - 1),
      stepOpButton(step.skipped ? '恢复' : '跳过', 'toggle-skip', index, false),
      stepOpButton('移除', 'remove', index, false)
    );
    head.appendChild(ops);
    card.appendChild(head);

    const select = document.createElement('select');
    select.className = 'chain-step-case';
    select.dataset.action = 'pick-case';
    select.dataset.index = String(index);
    select.setAttribute('aria-label', `第 ${index + 1} 步选择的用例`);
    select.add(new Option('请选择用例', ''));
    state.cases.forEach((item) => {
      select.add(new Option(`${item.method} · ${item.name}`, item.id));
    });
    if (step.caseId && !state.cases.some((item) => item.id === step.caseId)) {
      select.add(new Option('（用例已删除）', step.caseId));
    }
    select.value = step.caseId;
    card.appendChild(select);

    const caseItem = state.cases.find((item) => item.id === step.caseId);
    if (caseItem) {
      const summary = document.createElement('p');
      summary.className = 'chain-step-url';
      summary.textContent = `${caseItem.method} ${caseItem.url}`;
      card.appendChild(summary);
    }

    const extractsBox = document.createElement('div');
    extractsBox.className = 'chain-extracts';
    step.extracts.forEach((rule, ruleIndex) => {
      extractsBox.appendChild(buildExtractRow(step, index, rule, ruleIndex));
    });
    const addRule = document.createElement('button');
    addRule.type = 'button';
    addRule.className = 'btn btn-ghost btn-small';
    addRule.dataset.action = 'add-extract';
    addRule.dataset.index = String(index);
    addRule.textContent = '添加注入';
    extractsBox.appendChild(addRule);
    card.appendChild(extractsBox);

    const error = document.createElement('p');
    error.className = 'field-error chain-step-error';
    error.hidden = true;
    card.appendChild(error);

    return card;
  }

  function buildExtractRow(step, stepIndex, rule, ruleIndex) {
    const row = document.createElement('div');
    row.className = 'chain-extract-row';

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'extract-key';
    keyInput.placeholder = '占位标记，如 订单号';
    keyInput.value = rule.key;
    keyInput.dataset.action = 'extract-key';
    keyInput.dataset.index = String(stepIndex);
    keyInput.dataset.rule = String(ruleIndex);
    keyInput.autocomplete = 'off';

    const fromSelect = document.createElement('select');
    fromSelect.className = 'extract-from';
    fromSelect.dataset.action = 'extract-from';
    fromSelect.dataset.index = String(stepIndex);
    fromSelect.dataset.rule = String(ruleIndex);
    fromSelect.add(new Option('从哪一步取值', ''));
    state.chainSteps.forEach((item, itemIndex) => {
      if (itemIndex >= stepIndex) return;
      const sourceCase = state.cases.find((entry) => entry.id === item.caseId);
      const label = `第 ${itemIndex + 1} 步${sourceCase ? ` · ${sourceCase.name}` : ''}${item.skipped ? '（已跳过）' : ''}`;
      fromSelect.add(new Option(label, item.uid));
    });
    // 调整顺序后来源可能落到本步之后，或步骤已被移除，保留原值让校验提示
    if (rule.fromStep && !Array.from(fromSelect.options).some((option) => option.value === rule.fromStep)) {
      const missingIndex = state.chainSteps.findIndex((item) => item.uid === rule.fromStep);
      const label = missingIndex === -1 ? '（步骤已不存在）' : `第 ${missingIndex + 1} 步（不在本步之前）`;
      fromSelect.add(new Option(label, rule.fromStep));
    }
    fromSelect.value = rule.fromStep;

    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.className = 'extract-path';
    pathInput.placeholder = '取值路径，如 items[0].id';
    pathInput.value = rule.path;
    pathInput.dataset.action = 'extract-path';
    pathInput.dataset.index = String(stepIndex);
    pathInput.dataset.rule = String(ruleIndex);
    pathInput.autocomplete = 'off';
    pathInput.spellcheck = false;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-ghost btn-small';
    remove.textContent = '删除';
    remove.dataset.action = 'remove-extract';
    remove.dataset.index = String(stepIndex);
    remove.dataset.rule = String(ruleIndex);

    row.append(keyInput, fromSelect, pathInput, remove);
    return row;
  }

  // ---------------- 链路本地校验 ----------------

  // 与服务端一致的取值路径写法：items[0].id 与 items.0.id 都接受
  function parseExtractPathLocal(path) {
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

  // 在未跳过的步骤之间找互相依赖绕成一圈的情况，找到时返回圈上的步骤编号
  function findChainCycle(steps) {
    const graph = new Map();
    steps.forEach((step) => {
      if (!step.skipped) graph.set(step.uid, []);
    });
    steps.forEach((step) => {
      if (step.skipped) return;
      step.extracts.forEach((rule) => {
        if (graph.has(rule.fromStep)) graph.get(step.uid).push(rule.fromStep);
      });
    });
    const mark = new Map();
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

  // 本地校验：每次编辑后即时运行，把问题当场标到对应步骤上；保存与运行前再拦一次
  function validateChainLocal() {
    const errors = [];
    const steps = state.chainSteps;
    const caseIds = new Set(state.cases.map((item) => item.id));
    const indexById = new Map(steps.map((step, index) => [step.uid, index]));

    steps.forEach((step, index) => {
      if (step.skipped) return; // 被跳过的步骤不会执行，留待恢复时再检查
      if (!step.caseId) {
        errors.push({ stepIndex: index, message: `第 ${index + 1} 步还没有选择用例` });
      } else if (!caseIds.has(step.caseId)) {
        errors.push({ stepIndex: index, message: `第 ${index + 1} 步选择的用例不存在或已被删除` });
      }
      const seen = new Set();
      step.extracts.forEach((rule, ruleIndex) => {
        const where = `第 ${index + 1} 步的第 ${ruleIndex + 1} 条注入`;
        const key = rule.key.trim();
        if (!key) {
          errors.push({ stepIndex: index, message: `${where}还没有填写占位标记名称` });
        } else if (/[{}]/.test(key)) {
          errors.push({ stepIndex: index, message: `${where}的占位标记名称「${key}」里不能出现花括号` });
        } else if (seen.has(key)) {
          errors.push({ stepIndex: index, message: `第 ${index + 1} 步的占位标记「${key}」重复填写` });
        }
        seen.add(key);
        if (!rule.fromStep) errors.push({ stepIndex: index, message: `${where}还没有选择从哪一步取值` });
        if (!rule.path.trim()) {
          errors.push({ stepIndex: index, message: `${where}还没有填写取值路径` });
        } else if (!parseExtractPathLocal(rule.path)) {
          errors.push({ stepIndex: index, message: `${where}的取值路径「${rule.path.trim()}」写法不正确，示例：items[0].id` });
        }
      });
    });

    steps.forEach((step, index) => {
      if (step.skipped) return;
      step.extracts.forEach((rule) => {
        if (rule.fromStep && !indexById.has(rule.fromStep)) {
          errors.push({ stepIndex: index, message: `第 ${index + 1} 步的注入「{{${rule.key.trim()}}}」指向了链路里不存在的步骤` });
        }
      });
    });

    const cycle = findChainCycle(steps);
    if (cycle) {
      const labels = cycle.map((uid) => `第 ${indexById.get(uid) + 1} 步`).join(' 与 ');
      errors.push({ stepIndex: -1, message: `链路里 ${labels} 互相依赖，绕成了一圈，请调整取值方向` });
    }

    steps.forEach((step, index) => {
      if (step.skipped) return;
      step.extracts.forEach((rule) => {
        const fromIndex = indexById.get(rule.fromStep);
        if (fromIndex === undefined) return;
        if (fromIndex >= index) {
          errors.push({ stepIndex: index, message: `第 ${index + 1} 步的注入「{{${rule.key.trim()}}}」指向的第 ${fromIndex + 1} 步排在本步之后，取值时它还没执行` });
        } else if (steps[fromIndex].skipped) {
          errors.push({ stepIndex: index, message: `第 ${index + 1} 步的注入「{{${rule.key.trim()}}}」指向的第 ${fromIndex + 1} 步已被跳过，不会执行` });
        }
      });
    });

    return errors;
  }

  // 把校验结果标到页面上：-2 表示链路名称，-1 表示步骤整体，其余落到对应步骤卡片
  function renderChainErrors(errors) {
    const nameSlot = document.querySelector('[data-chain-error="name"]');
    const stepsSlot = document.querySelector('[data-chain-error="steps"]');
    if (nameSlot) {
      nameSlot.hidden = true;
      nameSlot.textContent = '';
    }
    if (stepsSlot) {
      stepsSlot.hidden = true;
      stepsSlot.textContent = '';
    }
    dom.chainSteps.querySelectorAll('.chain-step-error').forEach((node) => {
      node.hidden = true;
      node.textContent = '';
    });
    dom.chainSteps.querySelectorAll('.chain-step').forEach((node) => node.classList.remove('invalid'));

    errors.forEach((error) => {
      if (error.stepIndex === -2) {
        if (nameSlot) {
          nameSlot.textContent = error.message;
          nameSlot.hidden = false;
        }
        return;
      }
      if (error.stepIndex === -1) {
        if (stepsSlot) {
          stepsSlot.textContent = error.message;
          stepsSlot.hidden = false;
        }
        return;
      }
      const step = state.chainSteps[error.stepIndex];
      if (!step) return;
      const card = dom.chainSteps.querySelector(`[data-step-uid="${step.uid}"]`);
      const slot = card && card.querySelector('.chain-step-error');
      if (slot) {
        slot.textContent = error.message;
        slot.hidden = false;
        card.classList.add('invalid');
      }
    });
  }

  // 服务端返回的位置（steps.N.extracts.M...）归位到步骤卡片或整体区域
  function showChainError(err) {
    const field = typeof err.field === 'string' ? err.field : '';
    const stepMatch = field.match(/^steps\.(\d+)/);
    if (stepMatch) {
      renderChainErrors([{ stepIndex: Number(stepMatch[1]), message: err.message }]);
    } else if (field === 'name') {
      renderChainErrors([{ stepIndex: -2, message: err.message }]);
    } else if (field === 'steps') {
      renderChainErrors([{ stepIndex: -1, message: err.message }]);
    }
    showNotice(err.message, 'error');
  }

  // 结构变化（增删移、跳过、换用例）需要重绘步骤列表，文字输入只刷新校验与预览
  function afterChainEdit(rerender) {
    if (rerender) renderChainSteps();
    renderChainErrors(validateChainLocal());
    renderChainPreview();
  }

  function collectChainPayload() {
    return {
      name: dom.chainName.value.trim(),
      steps: state.chainSteps.map((step) => ({
        id: step.uid,
        caseId: step.caseId,
        skipped: step.skipped,
        extracts: step.extracts.map((rule) => ({
          id: rule.uid,
          key: rule.key.trim(),
          fromStep: rule.fromStep,
          path: rule.path.trim(),
        })),
      })),
    };
  }

  // ---------------- 链路保存、删除与运行 ----------------

  async function saveChain() {
    if (state.chainBusy) return;
    const errors = validateChainLocal();
    if (!dom.chainName.value.trim()) {
      errors.unshift({ stepIndex: -2, message: '请填写链路名称' });
    }
    renderChainErrors(errors);
    if (errors.length) {
      showNotice('链路还有问题没有处理，请按步骤上的提示调整', 'error');
      return;
    }

    setChainBusy(true, 'save');
    try {
      const payload = collectChainPayload();
      const saved = state.chainId
        ? await request(`/api/chains/${encodeURIComponent(state.chainId)}`, { method: 'PUT', body: payload })
        : await request('/api/chains', { method: 'POST', body: payload });
      await loadChains();
      loadChainIntoEditor(saved);
      showNotice(`链路「${saved.name}」已保存，重新打开页面依然在`, 'success');
    } catch (err) {
      showChainError(err);
    } finally {
      setChainBusy(false);
    }
  }

  async function deleteCurrentChain() {
    if (state.chainBusy || !state.chainId) return;
    const chain = state.chains.find((item) => item.id === state.chainId);
    const confirmed = window.confirm(`确认删除链路「${chain ? chain.name : ''}」？只删除链路本身，链路里用到的用例不受影响。`);
    if (!confirmed) return;

    setChainBusy(true);
    try {
      await request(`/api/chains/${encodeURIComponent(state.chainId)}`, { method: 'DELETE' });
      showNotice('链路已删除，用例不受影响', 'success');
      startNewChain();
      await loadChains();
    } catch (err) {
      showNotice(err.message, 'error');
    } finally {
      setChainBusy(false);
    }
  }

  async function runChainNow() {
    if (state.chainBusy) return;
    const errors = validateChainLocal();
    renderChainErrors(errors);
    if (errors.length) {
      showNotice('链路还有问题没有处理，请按步骤上的提示调整后再运行', 'error');
      return;
    }
    if (!state.chainSteps.some((step) => !step.skipped)) {
      renderChainErrors([{ stepIndex: -1, message: '链路里的步骤都被跳过了，至少恢复一步再运行' }]);
      showNotice('链路里的步骤都被跳过了，至少恢复一步再运行', 'error');
      return;
    }

    setChainBusy(true, 'run');
    renderChainRunPending();
    try {
      const result = await request('/api/chains/run', { method: 'POST', body: collectChainPayload() });
      state.chainRun = result;
      renderChainRun(result);
      if (result.ok) {
        const sent = result.steps.filter((step) => !step.skipped).length;
        showNotice(`链路运行完成：共 ${sent} 步，耗时 ${formatDuration(result.totalMs)}`, 'success');
      } else {
        showNotice(result.failure.message, 'error');
      }
    } catch (err) {
      state.chainRun = null;
      dom.chainRun.textContent = '';
      showChainError(err);
    } finally {
      setChainBusy(false);
    }
  }

  // ---------------- 链路发送预览 ----------------

  // 把文本里的 {{标记}} 拆出来高亮：有规则的按正常标记显示，没有规则的标成待补
  function appendTextWithPlaceholders(parent, text, step) {
    const pattern = /\{\{[^{}]+\}\}/g;
    let last = 0;
    let match = pattern.exec(text);
    while (match) {
      if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
      const key = match[0].slice(2, -2).trim();
      const known = step.extracts.some((rule) => rule.key.trim() === key);
      const span = document.createElement('span');
      span.className = known ? 'ph' : 'ph ph-missing';
      span.textContent = match[0];
      parent.appendChild(span);
      last = match.index + match[0].length;
      match = pattern.exec(text);
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function placeholderRegExpLocal(key) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`);
  }

  // 占位标记在用例内容里出现的位置，预览里据此说明值会被换到哪里
  function describeTargets(caseItem, key) {
    const pattern = placeholderRegExpLocal(key);
    const targets = [];
    if (pattern.test(caseItem.url)) targets.push('目标地址');
    caseItem.headers.forEach((row, index) => {
      if (pattern.test(row.key) || pattern.test(row.value)) targets.push(`第 ${index + 1} 行请求头`);
    });
    if (pattern.test(caseItem.body)) targets.push('请求内容');
    return targets;
  }

  function findPlaceholders(caseItem) {
    const keys = new Set();
    const scan = (text) => {
      const pattern = /\{\{([^{}]+)\}\}/g;
      let match = pattern.exec(text || '');
      while (match) {
        keys.add(match[1].trim());
        match = pattern.exec(text || '');
      }
    };
    scan(caseItem.url);
    caseItem.headers.forEach((row) => {
      scan(row.key);
      scan(row.value);
    });
    scan(caseItem.body);
    return Array.from(keys);
  }

  // 每一步的注入说明：值从哪一步的哪一段取、换到哪里；没有规则的标记单独提醒
  function buildInjectionNotes(step, stepIndex, caseItem) {
    const notes = [];
    const indexById = new Map(state.chainSteps.map((item, index) => [item.uid, index]));
    step.extracts.forEach((rule) => {
      const key = rule.key.trim();
      if (!key) return;
      const fromIndex = indexById.get(rule.fromStep);
      const targets = describeTargets(caseItem, key);
      const fromLabel = fromIndex === undefined ? '（步骤不存在）' : `第 ${fromIndex + 1} 步`;
      const pathLabel = rule.path.trim() || '（未填路径）';
      const targetLabel = targets.length ? `注入到 ${targets.join('、')}` : '内容里没有用到这个标记';
      notes.push({ text: `{{${key}}} ← ${fromLabel} · ${pathLabel} · ${targetLabel}`, warn: fromIndex === undefined });
    });
    findPlaceholders(caseItem).forEach((key) => {
      if (!step.extracts.some((rule) => rule.key.trim() === key)) {
        notes.push({ text: `{{${key}}} 没有对应的注入规则，运行时会原样发出`, warn: true });
      }
    });
    if (!notes.length) return null;
    const box = document.createElement('div');
    box.className = 'chain-inject-notes';
    notes.forEach((note) => {
      const line = document.createElement('p');
      line.className = note.warn ? 'chain-inject-note warn' : 'chain-inject-note';
      line.textContent = note.text;
      box.appendChild(line);
    });
    return box;
  }

  // 发送预览：按当前步骤顺序展示每一步实际会发出的内容，发送前就能确认
  function renderChainPreview() {
    dom.chainPreview.textContent = '';
    if (!state.chainSteps.length) return;

    const head = document.createElement('p');
    head.className = 'chain-block-title';
    head.textContent = '发送预览 · 运行前确认每一步实际发出的内容';
    dom.chainPreview.appendChild(head);

    state.chainSteps.forEach((step, index) => {
      const caseItem = state.cases.find((item) => item.id === step.caseId);
      const card = document.createElement('div');
      card.className = 'chain-preview-step';
      if (step.skipped) card.classList.add('skipped');

      const title = document.createElement('p');
      title.className = 'chain-preview-title';
      title.textContent = step.skipped
        ? `第 ${index + 1} 步 · ${caseItem ? caseItem.name : '未选择用例'}（已跳过，不会发出）`
        : `第 ${index + 1} 步 · ${caseItem ? caseItem.name : '未选择用例'}`;
      card.appendChild(title);

      if (!step.skipped && caseItem) {
        const urlLine = document.createElement('p');
        urlLine.className = 'chain-preview-line';
        urlLine.appendChild(buildTag(caseItem.method, String(caseItem.method).toLowerCase()));
        const urlText = document.createElement('span');
        urlText.className = 'chain-preview-url';
        appendTextWithPlaceholders(urlText, caseItem.url, step);
        urlLine.appendChild(urlText);
        card.appendChild(urlLine);

        if (caseItem.headers.length) {
          const headerBox = document.createElement('div');
          headerBox.className = 'chain-preview-headers';
          caseItem.headers.forEach((row) => {
            const line = document.createElement('p');
            line.className = 'chain-preview-header';
            const keyNode = document.createElement('span');
            keyNode.className = 'chain-preview-header-key';
            appendTextWithPlaceholders(keyNode, row.key, step);
            const valueNode = document.createElement('span');
            appendTextWithPlaceholders(valueNode, row.value, step);
            line.append(keyNode, document.createTextNode(': '), valueNode);
            headerBox.appendChild(line);
          });
          card.appendChild(headerBox);
        }

        if (caseItem.body) {
          const bodyPre = document.createElement('pre');
          bodyPre.className = 'chain-preview-body';
          appendTextWithPlaceholders(bodyPre, caseItem.body, step);
          card.appendChild(bodyPre);
        }

        const notes = buildInjectionNotes(step, index, caseItem);
        if (notes) card.appendChild(notes);
      }
      dom.chainPreview.appendChild(card);
    });
  }

  // ---------------- 链路运行结果 ----------------

  function renderChainRunPending() {
    dom.chainRun.textContent = '';
    const block = document.createElement('div');
    block.className = 'result-pending';
    const title = document.createElement('p');
    title.className = 'pending-title';
    title.textContent = '链路运行中，正在按顺序发送每一步…';
    const sub = document.createElement('p');
    sub.className = 'empty-sub';
    sub.textContent = '每一步发出的内容与取值来源会在运行结束后展示在这里。';
    block.append(title, sub);
    dom.chainRun.appendChild(block);
  }

  function describeRunTargets(targets) {
    if (!targets || !targets.length) return '内容里没有用到这个标记';
    return targets
      .map((targetRef) => {
        if (targetRef === 'url') return '目标地址';
        if (targetRef === 'body') return '请求内容';
        const match = /^header\.(\d+)$/.exec(targetRef);
        if (match) return `第 ${Number(match[1]) + 1} 行请求头`;
        return targetRef;
      })
      .join('、');
  }

  function buildRunStepCard(stepResult) {
    const card = document.createElement('div');
    card.className = 'chain-run-step';

    const head = document.createElement('div');
    head.className = 'result-head';
    const title = document.createElement('span');
    title.className = 'chain-run-title';
    title.textContent = `第 ${stepResult.index + 1} 步 · ${stepResult.caseName || '未选择用例'}`;
    head.appendChild(title);

    if (stepResult.skipped) {
      card.classList.add('skipped');
      head.appendChild(buildChip('已跳过，没有发出'));
      card.appendChild(head);
      return card;
    }

    if (stepResult.result && stepResult.result.ok) {
      head.appendChild(buildStatusBadge(stepResult.result.status, stepResult.result.statusText));
      head.appendChild(buildChip(`耗时 ${formatDuration(stepResult.result.timeMs)}`));
    } else {
      head.appendChild(buildStatusBadge(0, '未完成'));
      if (stepResult.result) head.appendChild(buildChip(`已等待 ${formatDuration(stepResult.result.timeMs)}`));
    }
    card.appendChild(head);

    if (stepResult.request) {
      const reqSection = buildSection('实际发出的请求');
      const urlLine = document.createElement('p');
      urlLine.className = 'result-target';
      urlLine.textContent = `${stepResult.request.method} ${stepResult.request.url}`;
      reqSection.appendChild(urlLine);
      if (stepResult.request.headers.length) {
        reqSection.appendChild(buildHeaderTable(stepResult.request.headers));
      }
      if (stepResult.request.body) reqSection.appendChild(buildPre(stepResult.request.body));
      card.appendChild(reqSection);
    }

    if (stepResult.injections && stepResult.injections.length) {
      const injSection = buildSection('本步换入的值');
      stepResult.injections.forEach((injection) => {
        const line = document.createElement('p');
        line.className = 'chain-inject-note';
        const valueText = injection.value.length > 120 ? `${injection.value.slice(0, 120)}…` : injection.value;
        line.textContent =
          `{{${injection.key}}} → ${JSON.stringify(valueText)} · 取自第 ${injection.fromIndex + 1} 步 · ` +
          `${injection.path} · 注入到 ${describeRunTargets(injection.targets)}`;
        injSection.appendChild(line);
      });
      card.appendChild(injSection);
    }

    const resSection = buildSection('响应');
    const res = stepResult.result;
    if (res && res.ok) {
      const bodyText = typeof res.body === 'string' ? res.body : '';
      if (bodyText.trim()) {
        const trimmed = bodyText.length > 4000 ? `${bodyText.slice(0, 4000)}\n…（内容较长，仅展示开头部分）` : bodyText;
        resSection.appendChild(buildPre(trimmed));
      } else {
        resSection.appendChild(buildTextNote('本次响应没有返回内容'));
      }
    } else if (res && res.failure) {
      resSection.appendChild(buildFailurePanel('请求没有完成', res.failure.reason, res.failure.detail));
    }
    card.appendChild(resSection);
    return card;
  }

  function renderChainRun(result) {
    dom.chainRun.textContent = '';

    const head = document.createElement('div');
    head.className = 'result-head';
    const badge = document.createElement('span');
    badge.className = result.ok ? 'status-badge status-ok' : 'status-badge status-bad';
    badge.textContent = result.ok ? '链路运行完成' : '链路未完成';
    head.appendChild(badge);
    head.appendChild(buildChip(`总耗时 ${formatDuration(result.totalMs)}`));
    dom.chainRun.appendChild(head);

    result.steps.forEach((stepResult) => {
      dom.chainRun.appendChild(buildRunStepCard(stepResult));
    });

    if (!result.ok && result.failure) {
      dom.chainRun.appendChild(buildFailurePanel(`链路在第 ${result.failure.stepIndex + 1} 步停下`, result.failure.message, ''));
    }
    dom.chainRun.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

    // 链路区：文字输入只更新状态与校验，结构变化才重绘步骤列表
    dom.chainSteps.addEventListener('input', (event) => {
      const target = event.target;
      const action = target.dataset ? target.dataset.action : '';
      const index = Number(target.dataset ? target.dataset.index : NaN);
      const ruleIndex = Number(target.dataset ? target.dataset.rule : NaN);
      const step = state.chainSteps[index];
      if (!step || !step.extracts[ruleIndex]) return;
      if (action === 'extract-key') step.extracts[ruleIndex].key = target.value;
      else if (action === 'extract-path') step.extracts[ruleIndex].path = target.value;
      else return;
      afterChainEdit(false);
    });

    dom.chainSteps.addEventListener('change', (event) => {
      const target = event.target;
      const action = target.dataset ? target.dataset.action : '';
      const index = Number(target.dataset ? target.dataset.index : NaN);
      const ruleIndex = Number(target.dataset ? target.dataset.rule : NaN);
      const step = state.chainSteps[index];
      if (!step) return;
      if (action === 'pick-case') {
        step.caseId = target.value;
        afterChainEdit(true);
      } else if (action === 'extract-from' && step.extracts[ruleIndex]) {
        step.extracts[ruleIndex].fromStep = target.value;
        afterChainEdit(true);
      }
    });

    dom.chainSteps.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      const index = Number(button.dataset.index);
      const step = state.chainSteps[index];
      if (action === 'add-extract' && step) {
        step.extracts.push(createEmptyExtract());
        afterChainEdit(true);
      } else if (action === 'remove-extract' && step) {
        step.extracts.splice(Number(button.dataset.rule), 1);
        afterChainEdit(true);
      } else if (action === 'move-up' && index > 0) {
        [state.chainSteps[index - 1], state.chainSteps[index]] = [state.chainSteps[index], state.chainSteps[index - 1]];
        afterChainEdit(true);
      } else if (action === 'move-down' && index < state.chainSteps.length - 1) {
        [state.chainSteps[index + 1], state.chainSteps[index]] = [state.chainSteps[index], state.chainSteps[index + 1]];
        afterChainEdit(true);
      } else if (action === 'toggle-skip' && step) {
        step.skipped = !step.skipped;
        afterChainEdit(true);
      } else if (action === 'remove' && step) {
        state.chainSteps.splice(index, 1);
        afterChainEdit(true);
      }
    });

    dom.addStep.addEventListener('click', () => {
      state.chainSteps.push(createEmptyStep());
      afterChainEdit(true);
    });

    dom.chainName.addEventListener('input', () => {
      const slot = document.querySelector('[data-chain-error="name"]');
      if (slot) slot.hidden = true;
    });

    dom.chainSelect.addEventListener('change', () => {
      const id = dom.chainSelect.value;
      if (!id) {
        startNewChain();
        return;
      }
      const chain = state.chains.find((item) => item.id === id);
      if (chain) {
        loadChainIntoEditor(chain);
        showNotice(`链路「${chain.name}」已打开`, 'info');
      }
    });

    dom.newChain.addEventListener('click', () => {
      if (state.chainBusy) return;
      startNewChain();
      showNotice('已开始新建链路，选好每一步的用例后点保存链路', 'info');
    });

    dom.deleteChain.addEventListener('click', deleteCurrentChain);
    dom.saveChain.addEventListener('click', saveChain);
    dom.runChain.addEventListener('click', runChainNow);

    dom.refreshChains.addEventListener('click', async () => {
      if (state.chainBusy) return;
      try {
        await loadCases();
        await loadChains();
        renderChainSteps();
        renderChainErrors(validateChainLocal());
        renderChainPreview();
        showNotice('用例与链路列表已刷新', 'info');
      } catch (err) {
        showNotice(err.message, 'error');
      }
    });
  }

  async function init() {
    bindEvents();
    renderHeaderRows();
    renderEmptyDetail();
    renderEmptyResult();
    renderCases();
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
    startNewChain();
  }

  init();
})();
