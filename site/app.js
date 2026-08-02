/* weekly study — 읽기는 누구나, 쓰기는 토큰을 넣은 본인만. */
(() => {
  'use strict';

  const API = 'https://api.github.com';
  const LS_TOKEN = 'ws.token';
  const LS_ME = 'ws.me';
  const LS_THEME = 'ws.theme';
  const TEMPLATE = '## 목표\n\n- \n\n## 달성 여부\n\n- \n';

  const STATUS_LABEL = {
    success: '성공',
    fail: '실패',
    note: '기록',
    pending: '미기록',
  };

  const state = {
    data: null,
    week: null,
    token: localStorage.getItem(LS_TOKEN) || '',
    me: localStorage.getItem(LS_ME) || '',
  };

  let scrollWeekIntoView = true;

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, props = {}, kids = []) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const kid of [].concat(kids)) {
      if (kid) node.append(kid);
    }
    return node;
  };

  /* ---------- 유틸 ---------- */

  const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function inlineMarkdown(text) {
    let html = escapeHtml(text);
    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_, label, href) => `<a href="${href}" target="_blank" rel="noopener">${label}</a>`);
    html = html.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
    return html;
  }

  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  function b64decode(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  function fmtRange(start, end) {
    const a = start.slice(5).replace('-', '.');
    const b = end.slice(5).replace('-', '.');
    return `${start.slice(0, 4)}.${a} – ${b}`;
  }

  /* ---------- 테마 ---------- */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(LS_THEME, theme);
    $('#theme-toggle').setAttribute(
      'aria-label',
      theme === 'dark' ? '밝은 테마로 전환' : '어두운 테마로 전환',
    );
  }

  /* ---------- 화면 치수 ---------- */

  /**
   * 고정 바 높이를 실제로 재서 CSS 변수에 넣는다. 상단바 높이를 상수로 박아두면
   * 노치 여백, 글자 크기 설정, 확대 배율에 따라 주차 목록이 겹치거나 떠 버린다.
   */
  function trackBarHeights() {
    const root = document.documentElement;
    const topbar = $('.topbar');

    const measure = () => {
      root.style.setProperty('--topbar-h', `${Math.round(topbar.getBoundingClientRect().height)}px`);
    };

    measure();
    if (window.ResizeObserver) new ResizeObserver(measure).observe(topbar);
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
  }

  /**
   * 조금만 스크롤해도 상단바를 줄인다. 켜고 끄는 기준을 벌려 두어야
   * 줄어든 높이 때문에 다시 펴지는 떨림이 생기지 않는다.
   */
  function trackScrolled() {
    let ticking = false;

    const update = () => {
      ticking = false;
      const y = window.scrollY;
      const on = document.body.classList.contains('scrolled');
      if (!on && y > 48) document.body.classList.add('scrolled');
      else if (on && y < 12) document.body.classList.remove('scrolled');
    };

    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    }, { passive: true });

    update();
  }

  /**
   * 화면 키보드가 올라오면 보이는 영역이 줄어드는데 dvh는 이를 따라오지 않는다.
   * visualViewport 높이를 시트 최대 높이로 써서 저장 버튼이 가려지지 않게 한다.
   */
  function trackViewportHeight() {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const update = () => {
      document.documentElement.style.setProperty(
        '--sheet-max',
        `${Math.round(viewport.height * 0.88)}px`,
      );
    };

    update();
    viewport.addEventListener('resize', update);
  }

  /* ---------- 진행 상태 ---------- */

  /**
   * 버튼을 누른 뒤 아무 반응이 없어 여러 번 누르는 일을 막는다.
   * 처리하는 동안 스피너를 돌리고 버튼을 잠근다.
   */
  async function withBusy(button, task) {
    if (!button) return task();
    if (button.disabled) return undefined;

    const label = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = '';
    button.append(el('span', { className: 'spinner' }), document.createTextNode(label));

    try {
      return await task();
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = label;
    }
  }

  let toastTimer;
  function toast(message) {
    const node = $('#toast');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
  }

  /* ---------- 마크다운 편집 ---------- */

  function parseBullets(block) {
    const roots = [];
    const stack = [];
    for (const raw of block.split('\n')) {
      if (!raw.trim()) continue;
      const m = raw.match(/^(\s*)[-*+]\s+(.*)$/);
      if (!m) {
        if (stack.length) stack[stack.length - 1].node.text += ` ${raw.trim()}`;
        continue;
      }
      const indent = m[1].replace(/\t/g, '    ').length;
      const node = { text: m[2].trim(), children: [] };
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
      stack.push({ indent, node });
    }
    return dropEmpty(roots);
  }

  /** 빈 템플릿의 '- ' 처럼 내용 없는 불릿은 목표로 치지 않는다. weekly.py와 같은 규칙. */
  function dropEmpty(nodes) {
    return nodes.filter((node) => {
      node.children = dropEmpty(node.children);
      return node.text || node.children.length;
    });
  }

  /** 달성 여부 본문에서 첫 불릿 내용만 뽑는다. weekly.py의 classify_status와 짝을 이룬다. */
  function firstBullet(block) {
    for (const raw of block.split('\n')) {
      const text = raw.replace(/^\s*[-*+]\s*/, '').trim();
      if (text) return text;
    }
    return '';
  }

  function classifyStatus(text) {
    if (!text) return 'pending';
    if (/^성공/.test(text)) return 'success';
    if (/^(실패|실퍠)/.test(text)) return 'fail';
    if (/(실패|실퍠)/.test(text)) return 'fail';
    if (/성공/.test(text)) return 'success';
    return 'note';
  }

  function sectionRegex(heading) {
    const target = heading.replace(/^#+\s*/, '').trim().split(/\s+/).map(escapeRe).join('\\s*');
    return new RegExp(`^#+\\s*${target}\\s*$`);
  }

  function readSection(content, heading) {
    const lines = content.split('\n');
    const re = sectionRegex(heading);
    let start = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (re.test(lines[i].trim())) { start = i; break; }
    }
    if (start === -1) return '';
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^#+\s+\S/.test(lines[i].trim())) { end = i; break; }
    }
    return lines.slice(start + 1, end).join('\n').replace(/^\n+|\n+$/g, '');
  }

  function replaceSection(content, heading, body) {
    const lines = content.split('\n');
    const re = sectionRegex(heading);
    let start = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (re.test(lines[i].trim())) { start = i; break; }
    }
    const block = ['', ...body.replace(/^\n+|\n+$/g, '').split('\n'), ''];
    if (start === -1) {
      return `${[...lines, '', heading, ...block].join('\n').replace(/\n+$/, '')}\n`;
    }
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^#+\s+\S/.test(lines[i].trim())) { end = i; break; }
    }
    const next = [...lines.slice(0, start + 1), ...block, ...lines.slice(end)];
    return `${next.join('\n').replace(/\n+$/, '')}\n`;
  }

  /* ---------- GitHub API ---------- */

  function gh(path, options = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    if (options.body) headers['Content-Type'] = 'application/json';
    // 인증 응답에는 max-age=60이 붙는다. 캐시된 sha로 쓰면 충돌하므로 항상 새로 받는다.
    return fetch(API + path, { ...options, cache: 'no-store', headers });
  }

  async function ghError(res) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.message || '';
    } catch { /* 본문이 없을 수 있다 */ }
    return `${res.status} ${detail}`.trim();
  }

  const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

  /** 섹션 하나만 갈아끼워 기본 브랜치에 커밋한다. */
  async function commitSection(path, heading, body, message) {
    const branch = state.data.defaultBranch;
    const url = `/repos/${state.data.repo}/contents/${encodePath(path)}`;

    const attempt = async () => {
      const current = await gh(`${url}?ref=${encodeURIComponent(branch)}`);
      let sha = null;
      let content = '';
      if (current.ok) {
        const json = await current.json();
        sha = json.sha;
        content = b64decode(json.content);
      } else if (current.status !== 404) {
        throw new Error(await ghError(current));
      }

      const next = replaceSection(content.trim() ? content : TEMPLATE, heading, body);
      return gh(url, {
        method: 'PUT',
        body: JSON.stringify({ message, content: b64encode(next), branch, ...(sha ? { sha } : {}) }),
      });
    };

    // 둘이 같은 순간에 저장하면 브랜치가 밀려 409나 422가 난다.
    // 섹션 하나만 덮어쓰므로 다시 읽어 다시 얹으면 상대 변경을 지우지 않는다.
    let res = await attempt();
    if (res.status === 409 || res.status === 422) res = await attempt();
    if (!res.ok) throw new Error(await ghError(res));
  }

  /**
   * data.json은 배포 시점에 만들어져서 방금 저장한 내용이 아직 빠져 있을 수 있다.
   * 배포를 기다리지 않도록 최근 두 주차만 기본 브랜치에서 다시 읽어 덮어쓴다.
   */
  async function overlayLatest() {
    if (!state.token) return;
    const branch = state.data.defaultBranch;

    const targets = [state.data.currentWeek, state.data.currentWeek - 1]
      .map(weekByNumber)
      .filter(Boolean);

    await Promise.all(targets.flatMap((week) => state.data.people.map(async (person) => {
      const entry = week.entries[person];
      try {
        const res = await gh(
          `/repos/${state.data.repo}/contents/${encodePath(entry.path)}?ref=${encodeURIComponent(branch)}`,
        );
        if (!res.ok) return;
        const content = b64decode((await res.json()).content);
        const goals = readSection(content, '## 목표');
        const statusText = firstBullet(readSection(content, '## 달성 여부'));

        entry.exists = true;
        entry.goals = parseBullets(goals);
        entry.goalsMarkdown = entry.goals.length ? goals : '';
        entry.statusText = statusText;
        entry.status = classifyStatus(statusText);
      } catch { /* 한 파일을 못 읽어도 나머지는 그대로 보여준다 */ }
    })));

    recomputeStreaks();
  }

  /* ---------- 렌더링 ---------- */

  function weekByNumber(n) {
    return state.data.weeks.find((w) => w.number === n) || null;
  }

  /** build_site.py의 success_streaks와 같은 규칙. 방금 쓴 결과가 바로 반영되게 한다. */
  function recomputeStreaks() {
    for (const person of state.data.people) {
      const decided = state.data.weeks
        .map((w) => w.entries[person].status)
        .filter((s) => s !== 'pending');

      let current = 0;
      for (let i = decided.length - 1; i >= 0 && decided[i] === 'success'; i -= 1) current += 1;

      let longest = 0;
      let run = 0;
      for (const status of decided) {
        run = status === 'success' ? run + 1 : 0;
        longest = Math.max(longest, run);
      }

      state.data.streaks[person] = {
        current,
        longest,
        totalSuccess: decided.filter((s) => s === 'success').length,
        totalDecided: decided.length,
      };
    }
  }

  function renderWeekList() {
    const list = $('#week-list');
    const jump = $('#week-jump');
    list.textContent = '';
    jump.textContent = '';

    const weeks = [...state.data.weeks].reverse();
    for (const week of weeks) {
      const button = el('button', { type: 'button' }, [
        el('strong', { textContent: `${week.number}주차` }),
        el('span', { textContent: fmtRange(week.start, week.end).slice(5) }),
      ]);
      button.addEventListener('click', () => selectWeek(week.number));
      if (week.number === state.week) button.setAttribute('aria-current', 'true');
      list.append(el('li', {}, button));

      jump.append(el('option', {
        value: String(week.number),
        textContent: `${week.number}주차`,
        selected: week.number === state.week,
      }));
    }

    // 주차를 바꿨을 때만 목록을 옮긴다. 저장할 때마다 옮기면 화면이 튄다.
    if (scrollWeekIntoView) {
      scrollWeekIntoView = false;
      const active = list.querySelector('[aria-current="true"]');
      if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }

  function goalsList(bullets) {
    const ul = el('ul', { className: 'goals' });
    for (const bullet of bullets) {
      const li = el('li');
      li.innerHTML = inlineMarkdown(bullet.text);
      if (bullet.children.length) li.append(goalsList(bullet.children));
      ul.append(li);
    }
    return ul;
  }

  function streakBlock(person) {
    const streak = state.data.streaks[person];
    const section = el('div', { className: 'peer-section' }, [
      el('h3', { textContent: 'STREAK' }),
    ]);

    section.append(el('div', { className: 'streak-top' }, [
      el('span', { className: 'streak-count', textContent: String(streak.current) }),
      el('span', { className: 'streak-label', textContent: '주 연속 성공' }),
      el('span', { className: 'streak-longest', textContent: `최장 ${streak.longest}주` }),
    ]));

    const grid = el('div', { className: 'grid' });
    const recent = state.data.weeks.slice(-52);
    for (const week of recent) {
      const status = week.entries[person].status;
      const cell = el('i');
      cell.dataset.s = status;
      cell.title = `${week.number}주차 · ${STATUS_LABEL[status]}`;
      grid.append(cell);
    }
    section.append(grid);
    section.append(el('p', {
      className: 'grid-caption',
      textContent: `최근 ${recent.length}주 · 성공 ${streak.totalSuccess}회 / 기록 ${streak.totalDecided}회`,
    }));
    return section;
  }

  function peerActions(week, person) {
    const canWrite = Boolean(state.token) && state.me === person;
    if (!canWrite) return null;

    const wrap = el('div', { className: 'peer-actions' });
    const entry = week.entries[person];

    const mark = (label, value) => {
      const button = el('button', { type: 'button', className: 'btn btn-sm', textContent: label });
      button.addEventListener('click', () => {
        withBusy(button, () => saveStatus(week, person, `- ${value}`));
      });
      return button;
    };

    wrap.append(mark('성공', '성공'));
    wrap.append(mark('실패', '실패'));

    const memo = el('button', { type: 'button', className: 'btn btn-sm', textContent: '메모' });
    memo.addEventListener('click', () => openEditor({
      title: `${week.number}주차 달성 여부`,
      hint: '자유롭게 적을 수 있습니다. 예: - 실패 (2장 읽는 중)',
      value: entry.statusText ? `- ${entry.statusText}` : '- ',
      onSave: (text) => saveStatus(week, person, text),
    }));
    wrap.append(memo);

    const previous = weekByNumber(week.number - 1);
    const previousGoals = previous ? previous.entries[person].goalsMarkdown.trim() : '';

    const goals = el('button', {
      type: 'button', className: 'btn btn-sm goal-edit',
      textContent: entry.goalsMarkdown.trim() ? '목표 수정' : '목표 작성',
    });
    goals.addEventListener('click', () => openEditor({
      title: `${week.number}주차 목표`,
      hint: '마크다운 불릿으로 씁니다. 들여쓰기 두 칸이면 하위 항목이 됩니다.',
      value: entry.goalsMarkdown.trim() ? entry.goalsMarkdown : '- ',
      prefill: previousGoals
        ? { label: `${previous.number}주차 내용 불러오기`, value: previousGoals }
        : null,
      onSave: (text) => saveGoals(week, person, text),
    }));
    wrap.append(goals);

    return wrap;
  }

  function renderPeer(week, person) {
    const entry = week.entries[person];
    const card = el('article', { className: 'peer' });

    card.append(el('div', { className: 'peer-head' }, [
      el('span', { className: 'peer-name', textContent: person }),
      (() => {
        const badge = el('span', { className: 'badge', textContent: STATUS_LABEL[entry.status] });
        badge.dataset.status = entry.status;
        return badge;
      })(),
    ]));

    const goalSection = el('div', { className: 'peer-section' }, [
      el('h3', { textContent: '목표' }),
    ]);
    if (entry.goals.length) {
      goalSection.append(goalsList(entry.goals));
    } else {
      goalSection.append(el('p', { className: 'empty', textContent: '아직 목표가 없습니다.' }));
    }
    card.append(goalSection);

    // 배지에 이미 드러난 한 단어짜리 결과는 아래에 또 적지 않는다.
    const redundant = entry.statusText === STATUS_LABEL[entry.status];
    if (!redundant) {
      const statusSection = el('div', { className: 'peer-section' }, [
        el('h3', { textContent: '달성 여부' }),
      ]);
      statusSection.append(entry.statusText
        ? el('p', { className: 'status-note', textContent: entry.statusText })
        : el('p', { className: 'empty', textContent: '아직 기록 전입니다.' }));
      card.append(statusSection);
    }

    card.append(streakBlock(person));

    const actions = peerActions(week, person);
    if (actions) card.append(actions);

    return card;
  }

  function renderDetail() {
    const detail = $('#detail');
    detail.textContent = '';

    const week = weekByNumber(state.week);
    if (!week) {
      detail.append(el('p', { className: 'loading', textContent: '주차를 찾을 수 없습니다.' }));
      return;
    }

    const head = el('div', { className: 'week-head' }, [
      el('div', { className: 'range', textContent: `${fmtRange(week.start, week.end)} (일–토)` }),
      el('h2', { textContent: `${week.number}주차` }),
    ]);
    if (week.isCurrent) head.append(el('span', { className: 'flag', textContent: '이번 주' }));
    detail.append(head);

    const peers = el('div', { className: 'peers' });
    // data.people 순서를 그대로 따른다. 두 칸은 크기도 스타일도 같다.
    for (const person of state.data.people) peers.append(renderPeer(week, person));
    detail.append(peers);
  }

  function render() {
    renderWeekList();
    renderDetail();
  }

  function selectWeek(number) {
    state.week = number;
    scrollWeekIntoView = true;
    history.replaceState(null, '', `#week-${number}`);
    render();
  }

  /* ---------- 쓰기 동작 ---------- */

  const SAVED = '저장했습니다. 잠시 뒤 페이지에 반영됩니다.';

  async function saveStatus(week, person, body) {
    try {
      await commitSection(
        week.entries[person].path,
        '## 달성 여부',
        body,
        `${week.number}주차 달성 여부 작성`,
      );
      const text = firstBullet(body);
      const entry = week.entries[person];
      entry.statusText = text;
      entry.status = classifyStatus(text);
      recomputeStreaks();
      render();
      toast(SAVED);
      return true;
    } catch (err) {
      toast(`저장 실패: ${err.message}`);
      return false;
    }
  }

  async function saveGoals(week, person, body) {
    try {
      await commitSection(
        week.entries[person].path,
        '## 목표',
        body,
        `${week.number}주차 목표 작성`,
      );
      const entry = week.entries[person];
      entry.goals = parseBullets(body);
      entry.goalsMarkdown = entry.goals.length ? body.trim() : '';
      entry.exists = true;
      render();
      toast(SAVED);
      return true;
    } catch (err) {
      toast(`저장 실패: ${err.message}`);
      return false;
    }
  }

  /* ---------- 편집 시트 ---------- */

  let editorSave = null;

  function openEditor({ title, hint, value, prefill = null, onSave }) {
    $('#editor-title').textContent = title;
    $('#editor-hint').textContent = hint;
    $('#editor-text').value = value;

    const button = $('#editor-prefill');
    button.hidden = !prefill;
    if (prefill) {
      button.textContent = prefill.label;
      button.onclick = () => {
        const text = $('#editor-text');
        text.value = prefill.value;
        text.focus();
        text.setSelectionRange(text.value.length, text.value.length);
      };
    }

    editorSave = onSave;
    openSheet($('#editor'));
  }

  /**
   * 시트 바깥(빈 영역)을 누르면 닫고, 열려 있는 동안 뒤 화면 스크롤을 잠근다.
   * 잠그지 않으면 모바일에서 시트를 넘길 때 배경이 같이 밀려 화면이 어긋난다.
   */
  function setUpSheet(dialog) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => {
      if (!document.querySelector('dialog[open]')) {
        document.body.classList.remove('modal-open');
      }
    });
  }

  function openSheet(dialog) {
    document.body.classList.add('modal-open');
    dialog.showModal();
  }

  /* ---------- 설정 ---------- */

  function renderWhoOptions() {
    const wrap = $('#who-options');
    wrap.textContent = '';
    for (const person of state.data.people) {
      const input = el('input', { type: 'radio', name: 'who', value: person });
      input.checked = state.me === person;
      wrap.append(el('label', {}, [input, document.createTextNode(person)]));
    }
  }

  function wireEvents() {
    $('#theme-toggle').addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });

    $('#settings-open').addEventListener('click', () => {
      renderWhoOptions();
      $('#who-error').hidden = true;
      $('#token').value = state.token;
      openSheet($('#settings'));
    });

    $('#settings-save').addEventListener('click', (event) => {
      const picked = document.querySelector('input[name="who"]:checked');
      if (!picked) {
        $('#who-error').hidden = false;
        return;
      }
      $('#who-error').hidden = true;

      withBusy(event.currentTarget, async () => {
        state.me = picked.value;
        state.token = $('#token').value.trim();
        localStorage.setItem(LS_ME, state.me);
        if (state.token) localStorage.setItem(LS_TOKEN, state.token);
        else localStorage.removeItem(LS_TOKEN);

        render();
        await overlayLatest();
        render();
        $('#settings').close();
        toast(state.token ? '설정을 저장했습니다.' : '읽기 전용으로 전환했습니다.');
      });
    });

    $('#token-clear').addEventListener('click', () => {
      state.token = '';
      localStorage.removeItem(LS_TOKEN);
      $('#token').value = '';
      $('#settings').close();
      render();
      toast('토큰을 지웠습니다.');
    });

    $('#editor').addEventListener('close', () => { editorSave = null; });
    $('#editor-cancel').addEventListener('click', () => $('#editor').close());
    $('#editor-save').addEventListener('click', (event) => {
      const value = $('#editor-text').value;
      const save = editorSave;
      if (!save) return;
      withBusy(event.currentTarget, async () => {
        if (await save(value)) $('#editor').close();
      });
    });

    setUpSheet($('#settings'));
    setUpSheet($('#editor'));

    $('#week-jump').addEventListener('change', (event) => {
      selectWeek(Number(event.target.value));
    });
  }

  /* ---------- 시작 ---------- */

  async function init() {
    applyTheme(localStorage.getItem(LS_THEME) === 'light' ? 'light' : 'dark');

    try {
      const res = await fetch(`data.json?t=${Date.now()}`);
      state.data = await res.json();
    } catch {
      $('#detail').textContent = '데이터를 불러오지 못했습니다.';
      return;
    }

    const fromHash = Number((location.hash.match(/^#week-(\d+)$/) || [])[1]);
    state.week = weekByNumber(fromHash) ? fromHash : state.data.currentWeek;
    if (!weekByNumber(state.week)) {
      state.week = state.data.weeks[state.data.weeks.length - 1].number;
    }

    wireEvents();
    trackViewportHeight();
    trackScrolled();
    trackBarHeights();

    render();
    await overlayLatest();
    render();
  }

  init();
})();
