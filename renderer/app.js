/* =====================================================================
 * 회사 스케줄 관리 — 앱 로직
 * 인증(Supabase Auth) + 역할(admin/staff) + 실시간 공유 데이터
 * ===================================================================== */
'use strict';

// ---------------- 상수 / 스타일 맵 (원본 디자인 기준) ----------------
const STATUS_MAP = {
  '진행중':   { color: '#0A84FF', bg: '#EAF3FF' },
  '대기':     { color: '#86868B', bg: '#F0F0F2' },
  '완료':     { color: '#30A46C', bg: '#E7F6EC' },
  '지연':     { color: '#FF9500', bg: '#FFF2E0' },
  '진행 예정': { color: '#FF3B30', bg: '#FFECEB' }
};
const CLIENT_COLORS = ['#86868B', '#0A84FF', '#30A46C', '#C77700', '#7A3FE0', '#D81B60', '#1E6FD9'];
const CLIENT_BGS    = ['#F0F0F2', '#EAF3FF', '#E7F6EC', '#FFF2E0', '#EDE4FF', '#FFE0E9', '#E3F0FF'];
const EVENT_COLORS  = ['#0A84FF', '#FF3B30', '#FF9500', '#30D158', '#BF5AF2', '#5AC8FA'];
const AVATAR_PALETTE = [
  ['#EAF3FF', '#0A84FF'], ['#FFE9E0', '#E85D3D'], ['#E7F6EC', '#30A46C'],
  ['#EDE4FF', '#7A3FE0'], ['#FFE0E9', '#D81B60'], ['#E3F0FF', '#1E6FD9'],
  ['#FFF2E0', '#C77700']
];
const STATUS_OPTIONS = Object.keys(STATUS_MAP);

// ---------------- 전역 상태 ----------------
let sb = null;            // supabase client
let me = null;            // { id, name, role }
let DB = { tasks: [], clients: [], agenda: [], memos: [], checklist: [] };
let calCursor = new Date();          // 캘린더가 보여주는 달
let selectedDate = toISO(new Date()); // 일정 카드가 보여주는 날짜
let drawerState = null;              // { mode: 'view'|'edit'|'new', type, id }
let realtimeTimer = null;

// ---------------- 유틸 ----------------
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function toISO(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function fmtMD(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
}
function hashIdx(str, mod) {
  let h = 0;
  for (const ch of String(str || '')) h = (h * 31 + ch.codePointAt(0)) % 997;
  return h % mod;
}
function clientStyle(name) {
  const i = name === '내부' ? 0 : 1 + hashIdx(name, CLIENT_COLORS.length - 1);
  return { color: CLIENT_COLORS[i], bg: CLIENT_BGS[i] };
}
function avatarStyle(name) {
  const [bg, color] = AVATAR_PALETTE[hashIdx(name, AVATAR_PALETTE.length)];
  return { bg, color };
}
function statusStyle(s) { return STATUS_MAP[s] || STATUS_MAP['대기']; }
function ddayText(iso) {
  if (!iso) return '';
  const diff = Math.round((new Date(iso + 'T00:00:00') - new Date(toISO(new Date()) + 'T00:00:00')) / 86400000);
  return diff === 0 ? 'D-0' : diff > 0 ? `D-${diff}` : `D+${-diff}`;
}
function checklistOf(type, id) {
  return DB.checklist.filter(c => c.parent_type === type && c.parent_id === id)
    .sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at));
}
function progressOf(type, id) {
  const list = checklistOf(type, id);
  if (!list.length) return 0;
  return Math.round(list.filter(c => c.done).length / list.length * 100);
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}
function isAdmin() { return me && me.role === 'admin'; }
function canEdit(type, item) {
  if (isAdmin()) return true;
  if (type === 'task') return item.scope === 'staff';
  if (type === 'agenda') return true;
  return false; // client, memo → 관리자만
}

// ---------------- 부팅 ----------------
window.addEventListener('DOMContentLoaded', boot);

async function boot() {
  const cfg = window.APP_CONFIG || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    $('boot-loading').innerHTML =
      '<div style="text-align:center;line-height:1.7;">' +
      '<b>Supabase 설정이 비어 있습니다.</b><br>' +
      'renderer/config.js 에 SUPABASE_URL 과 SUPABASE_ANON_KEY 를 입력한 뒤 다시 실행하세요.</div>';
    return;
  }
  sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  bindStaticEvents();

  const { data: { session } } = await sb.auth.getSession();
  if (session) await enterApp();
  else showLogin();
}

function showLogin() {
  $('boot-loading').classList.add('hidden');
  $('app-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
}

// ---------------- 로그인 / 로그아웃 ----------------
function bindStaticEvents() {
  $('login-btn').addEventListener('click', doLogin);
  $('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('logout-btn').addEventListener('click', async () => {
    await sb.auth.signOut();
    location.reload();
  });

  $('cal-prev').addEventListener('click', () => { calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); });
  $('cal-next').addEventListener('click', () => { calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); });

  $('tab-schedule').addEventListener('click', () => setAdminTab('schedule'));
  $('tab-memo').addEventListener('click', () => setAdminTab('memo'));

  $('agenda-add').addEventListener('click', () => openDrawer({ mode: 'new', type: 'agenda' }));
  $('staff-add').addEventListener('click', () => openDrawer({ mode: 'new', type: 'task', scope: 'staff' }));
  $('admin-add').addEventListener('click', () => {
    const memoTab = !$('admin-memo-tab').classList.contains('hidden');
    openDrawer(memoTab ? { mode: 'new', type: 'memo' } : { mode: 'new', type: 'task', scope: 'admin' });
  });
  $('client-add').addEventListener('click', () => openDrawer({ mode: 'new', type: 'client' }));

  $('drawer-backdrop').addEventListener('click', closeDrawer);
  window.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

  // 위젯 모드 (Electron 데스크톱에서만 동작)
  if (window.desktop) {
    window.desktop.getMode().then(mode => {
      const widget = mode === 'widget';
      document.body.classList.toggle('widget-mode', widget);
      $('widget-bar').classList.toggle('hidden', !widget);
      $('widget-btn').textContent = widget ? '일반 창으로' : '위젯 모드';
      $('widget-btn').classList.remove('hidden');
    });
    $('widget-btn').addEventListener('click', () => window.desktop.toggleWidget());
    $('widget-unpin').addEventListener('click', () => window.desktop.toggleWidget());
    $('widget-quit').addEventListener('click', () => window.desktop.quit());
  }

  // 회원 관리 (관리자 전용)
  $('members-btn').addEventListener('click', openMembersPanel);

  // 자동 업데이트 알림
  if (window.desktop) {
    window.desktop.onUpdateReady(showUpdateBanner);
    window.desktop.getPendingUpdate().then(v => { if (v) showUpdateBanner(v); });
  }
}

function showUpdateBanner(version) {
  if ($('update-banner')) return; // 중복 방지
  const bar = el('div');
  bar.id = 'update-banner';
  bar.innerHTML = `새 버전 <b>v${version}</b> 이 준비되었습니다. 지금 적용하거나, 앱 종료 시 자동 적용됩니다.`;
  const btn = el('button', null, '지금 재시작하고 적용');
  btn.addEventListener('click', () => window.desktop.installUpdate());
  const later = el('button', 'later', '나중에');
  later.addEventListener('click', () => bar.remove());
  bar.append(btn, later);
  document.body.appendChild(bar);
}

async function doLogin() {
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  const err = $('login-error');
  err.classList.add('hidden');
  if (!email || !password) { err.textContent = '이메일과 비밀번호를 입력하세요.'; err.classList.remove('hidden'); return; }

  $('login-btn').disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  $('login-btn').disabled = false;

  if (error) {
    err.textContent = '로그인할 수 없습니다. 계정 정보가 올바른지, 접근 권한이 있는지 확인하세요.';
    err.classList.remove('hidden');
    return;
  }
  await enterApp();
}

async function enterApp() {
  const { data: { user } } = await sb.auth.getUser();
  const { data: profile, error } = await sb.from('profiles').select('*').eq('id', user.id).single();
  if (error || !profile) {
    await sb.auth.signOut();
    showLogin();
    const err = $('login-error');
    err.textContent = '이 계정에는 접근 권한이 없습니다. 관리자에게 문의하세요.';
    err.classList.remove('hidden');
    return;
  }
  me = { id: user.id, name: profile.name || user.email, role: profile.role };

  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');

  // 우측 상단 역할 표기
  $('user-name').textContent = me.name;
  const badge = $('role-badge');
  badge.textContent = isAdmin() ? '관리자' : '일반 직원';
  badge.className = 'role-badge ' + (isAdmin() ? 'admin' : 'staff');

  // 관리자 전용 카드 / 클라이언트 추가 / 회원 관리 버튼
  $('admin-card').classList.toggle('hidden', !isAdmin());
  $('client-add').classList.toggle('hidden', !isAdmin());
  $('members-btn').classList.toggle('hidden', !isAdmin());

  const now = new Date();
  $('header-date').textContent =
    `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 · ${['일','월','화','수','목','금','토'][now.getDay()]}요일`;

  await loadAll();
  subscribeRealtime();
  $('boot-loading').classList.add('hidden');
}

// ---------------- 데이터 로드 / 실시간 ----------------
async function loadAll() {
  const [tasks, clients, agenda, memos, checklist] = await Promise.all([
    sb.from('tasks').select('*').order('deadline', { ascending: true, nullsFirst: false }),
    sb.from('clients').select('*').order('deadline', { ascending: true, nullsFirst: false }),
    sb.from('agenda').select('*').order('start_time'),
    sb.from('memos').select('*').order('created_at'),
    sb.from('checklist_items').select('*')
  ]);
  DB.tasks = tasks.data || [];
  DB.clients = clients.data || [];
  DB.agenda = agenda.data || [];
  DB.memos = memos.data || [];
  DB.checklist = checklist.data || [];
  renderAll();
}

function subscribeRealtime() {
  sb.channel('db-sync')
    .on('postgres_changes', { event: '*', schema: 'public' }, () => {
      clearTimeout(realtimeTimer);
      realtimeTimer = setTimeout(loadAll, 250); // 연속 변경 디바운스
    })
    .subscribe();
}

// ---------------- 전체 렌더 ----------------
function renderAll() {
  renderHeaderStats();
  renderCalendar();
  renderAgenda();
  renderUrgent();
  renderTasks();
  renderMemos();
  renderClients();
  if (drawerState && drawerState.mode === 'view') refreshDrawerView();
}

function renderHeaderStats() {
  const today = toISO(new Date());
  const todayAgenda = DB.agenda.filter(a => a.date === today);
  const todayTasks = DB.tasks.filter(t => t.deadline === today);
  const total = todayAgenda.length + todayTasks.length;
  const done = DB.tasks.filter(t => t.status === '완료').length;
  const doing = DB.tasks.filter(t => t.status === '진행중').length;
  const urgent = todayAgenda.filter(a => a.urgent).length;

  $('header-stats').innerHTML = '';
  const s1 = el('span'); s1.innerHTML = `오늘 <b>${total}</b>건`;
  const mk = (color, label) => {
    const s = el('span', 'stat-dot');
    const dot = el('i'); dot.style.background = color;
    s.appendChild(dot); s.appendChild(document.createTextNode(label));
    return s;
  };
  $('header-stats').append(s1, mk('#30D158', `완료 ${done}`), mk('#0A84FF', `진행 ${doing}`), mk('#FF3B30', `긴급 ${urgent}`));
}

// ---------------- 캘린더 ----------------
function renderCalendar() {
  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  $('cal-title').innerHTML = `${m + 1}월 <span>${y}</span>`;

  // 날짜별 도트 수집: 일정 색 + 업무 기한(상태색)
  const dots = {};
  const push = (iso, color) => {
    if (!iso) return;
    (dots[iso] = dots[iso] || []).length < 4 && dots[iso].push(color);
  };
  DB.agenda.forEach(a => push(a.date, a.color));
  DB.tasks.forEach(t => push(t.deadline, statusStyle(t.status).color));
  DB.clients.forEach(c => push(c.deadline, c.color));

  const first = new Date(y, m, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay()); // 일요일 시작

  const body = $('cal-body');
  body.innerHTML = '';
  const today = toISO(new Date());

  for (let w = 0; w < 6; w++) {
    const week = el('div', 'cal-week');
    for (let d = 0; d < 7; d++) {
      const cur = new Date(start);
      cur.setDate(start.getDate() + w * 7 + d);
      const iso = toISO(cur);
      const cell = el('div', 'cal-day');
      if (cur.getMonth() !== m) cell.classList.add('muted');
      if (iso === today) cell.classList.add('today');
      if (iso === selectedDate) cell.classList.add('selected');

      cell.appendChild(el('div', 'cal-num', String(cur.getDate())));
      const dotWrap = el('div', 'cal-dots');
      (dots[iso] || []).forEach(c => {
        const s = el('span'); s.style.background = c; dotWrap.appendChild(s);
      });
      cell.appendChild(dotWrap);

      cell.addEventListener('click', () => {
        selectedDate = iso;
        renderCalendar();
        renderAgenda();
      });
      week.appendChild(cell);
    }
    body.appendChild(week);
    // 마지막 주가 전부 다음 달이면 중단
    const nextRowStart = new Date(start);
    nextRowStart.setDate(start.getDate() + (w + 1) * 7);
    if (nextRowStart.getMonth() !== m && nextRowStart > first) break;
  }
}

// ---------------- 오늘/선택일 일정 ----------------
function renderAgenda() {
  const today = toISO(new Date());
  const isToday = selectedDate === today;
  $('agenda-title').textContent = isToday ? '오늘' : '선택한 날짜';
  $('agenda-date').textContent = fmtMD(selectedDate).replace('/', '월 ') + '일';

  const list = $('agenda-list');
  list.innerHTML = '';
  const items = DB.agenda.filter(a => a.date === selectedDate)
    .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));

  if (!items.length) {
    list.appendChild(el('div', 'empty-note', '등록된 일정이 없습니다. + 버튼으로 추가하세요.'));
    return;
  }
  items.forEach(a => {
    const row = el('div', 'agenda-item');
    const bar = el('div', 'agenda-bar'); bar.style.background = a.color;
    const mid = el('div'); mid.style.flex = '1';
    const meta = el('div');
    meta.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:3px;';
    meta.appendChild(el('span', 'agenda-time', a.start_time + (a.end_time ? ' – ' + a.end_time : '')));
    if (a.urgent) meta.appendChild(el('span', 'urgent-tag', '긴급'));
    mid.appendChild(meta);
    mid.appendChild(el('div', 'agenda-title', a.title));
    row.append(bar, mid, el('div', 'agenda-chevron', '›'));
    row.addEventListener('click', () => openDrawer({ mode: 'view', type: 'agenda', id: a.id }));
    list.appendChild(row);
  });
}

// ---------------- 긴급 스케줄 ----------------
function renderUrgent() {
  const today = toISO(new Date());
  const items = DB.agenda.filter(a => a.urgent && a.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time))
    .slice(0, 4);
  $('urgent-count').textContent = String(items.length);
  const grid = $('urgent-grid');
  grid.innerHTML = '';
  if (!items.length) {
    grid.appendChild(el('div', 'empty-note', '긴급 일정이 없습니다.'));
    return;
  }
  items.forEach(a => {
    const box = el('div', 'urgent-item');
    const t = el('div', 'urgent-time');
    const b = el('b', null, a.start_time || fmtMD(a.date));
    const s = el('span', null, a.date === today ? '오늘' : fmtMD(a.date));
    t.append(b, s);
    const body = el('div'); body.style.flex = '1';
    body.appendChild(el('div', 'urgent-title', a.title));
    body.appendChild(el('div', 'urgent-sub', [a.attendees, a.location].filter(Boolean).join(' · ') || a.client));
    box.append(t, body);
    box.addEventListener('click', () => openDrawer({ mode: 'view', type: 'agenda', id: a.id }));
    grid.appendChild(box);
  });
}

// ---------------- 업무 테이블 ----------------
function taskRow(t) {
  const row = el('div', 'task-row');
  row.appendChild(el('div', 'task-title', t.title));

  const person = el('div', 'task-person');
  const av = el('span', 'avatar', (t.assignee || '?').slice(0, 1));
  const avs = avatarStyle(t.assignee);
  av.style.background = avs.bg; av.style.color = avs.color;
  person.append(av, el('span', null, t.assignee || '미지정'));
  row.appendChild(person);

  row.appendChild(el('div', null, fmtMD(t.deadline)));

  const st = statusStyle(t.status);
  const pillWrap = el('div');
  const pill = el('span', 'pill', t.status);
  pill.style.color = st.color; pill.style.background = st.bg;
  pillWrap.appendChild(pill);
  row.appendChild(pillWrap);

  const cs = clientStyle(t.client);
  const tagWrap = el('div');
  const tag = el('span', 'tag', t.client);
  tag.style.color = cs.color; tag.style.background = cs.bg;
  tagWrap.appendChild(tag);
  row.appendChild(tagWrap);

  row.addEventListener('click', () => openDrawer({ mode: 'view', type: 'task', id: t.id }));
  return row;
}

function renderTasks() {
  const adminWrap = $('admin-rows'), staffWrap = $('staff-rows');
  adminWrap.innerHTML = ''; staffWrap.innerHTML = '';
  const admins = DB.tasks.filter(t => t.scope === 'admin');
  const staffs = DB.tasks.filter(t => t.scope === 'staff');
  if (isAdmin()) {
    if (!admins.length) adminWrap.appendChild(el('div', 'empty-note', '등록된 업무가 없습니다.'));
    admins.forEach(t => adminWrap.appendChild(taskRow(t)));
  }
  if (!staffs.length) staffWrap.appendChild(el('div', 'empty-note', '등록된 업무가 없습니다.'));
  staffs.forEach(t => staffWrap.appendChild(taskRow(t)));
}

function setAdminTab(tab) {
  const isSchedule = tab === 'schedule';
  $('tab-schedule').classList.toggle('active', isSchedule);
  $('tab-memo').classList.toggle('active', !isSchedule);
  $('admin-schedule-tab').classList.toggle('hidden', !isSchedule);
  $('admin-memo-tab').classList.toggle('hidden', isSchedule);
}

// ---------------- 메모 ----------------
function renderMemos() {
  const grid = $('memo-grid');
  grid.innerHTML = '';
  if (!DB.memos.length) {
    grid.appendChild(el('div', 'empty-note', '등록된 메모가 없습니다.'));
    return;
  }
  DB.memos.forEach(m => {
    const item = el('div', 'memo-item');
    const chk = el('span', 'memo-check' + (m.done ? ' done' : ''), m.done ? '✓' : '');
    chk.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { error } = await sb.from('memos').update({ done: !m.done }).eq('id', m.id);
      if (error) toast('변경 권한이 없습니다.');
      else loadAll();
    });
    const txt = el('span', 'txt' + (m.done ? ' done' : ''), m.text);
    item.append(chk, txt);
    item.addEventListener('click', () => openDrawer({ mode: 'view', type: 'memo', id: m.id }));
    grid.appendChild(item);
  });
}

// ---------------- 클라이언트 ----------------
function renderClients() {
  const grid = $('client-grid');
  grid.innerHTML = '';
  $('client-count').textContent = `진행 프로젝트 ${DB.clients.length}`;
  if (!DB.clients.length) {
    grid.appendChild(el('div', 'empty-note', '진행 중인 프로젝트가 없습니다.'));
    return;
  }
  DB.clients.forEach(c => {
    const prog = progressOf('client', c.id);
    const card = el('div', 'client-item');
    const top = el('div', 'client-top');
    const badge = el('span', 'client-badge', c.badge);
    badge.style.background = c.color;
    const nameWrap = el('div');
    nameWrap.appendChild(el('div', 'client-name', c.name));
    nameWrap.appendChild(el('div', 'client-next', c.next_meeting ? '다음 미팅 ' + fmtMD(c.next_meeting) : '미팅 미정'));
    top.append(badge, nameWrap);

    const barBg = el('div', 'client-bar-bg');
    const bar = el('div', 'client-bar');
    bar.style.width = prog + '%'; bar.style.background = c.color;
    barBg.appendChild(bar);

    const foot = el('div', 'client-foot');
    foot.appendChild(el('span', null, `진행률 ${prog}%`));
    foot.appendChild(el('span', null, ddayText(c.deadline)));

    card.append(top, barBg, foot);
    card.addEventListener('click', () => openDrawer({ mode: 'view', type: 'client', id: c.id }));
    grid.appendChild(card);
  });
}

/* =====================================================================
 * 디테일 드로어 (보기 / 편집 / 신규)
 * ===================================================================== */
const TYPE_META = {
  task:   { table: 'tasks',  cat: (t) => t.scope === 'admin' ? ['관리자 전용', '#0A84FF', '#EAF3FF'] : ['직원 전용', '#30A46C', '#E7F6EC'] },
  client: { table: 'clients', cat: (c) => ['클라이언트 프로젝트', c.color, '#EAF3FF'] },
  agenda: { table: 'agenda', cat: (a) => ['일정', a.color, '#F0F0F2'] },
  memo:   { table: 'memos',  cat: () => ['회사 개선 사항', '#C77700', '#FFF2E0'] }
};

function findItem(type, id) {
  const list = { task: DB.tasks, client: DB.clients, agenda: DB.agenda, memo: DB.memos }[type];
  return list.find(x => x.id === id);
}

function openDrawer(state) {
  drawerState = state;
  $('drawer').classList.add('open');
  $('drawer-backdrop').classList.add('open');
  if (state.mode === 'view') refreshDrawerView();
  else renderDrawerForm();
}
function closeDrawer() {
  drawerState = null;
  $('drawer').classList.remove('open');
  $('drawer-backdrop').classList.remove('open');
}

// ---------- 보기 모드 ----------
function refreshDrawerView() {
  const { type, id } = drawerState;
  const item = findItem(type, id);
  if (!item) { closeDrawer(); return; }

  const d = $('drawer');
  d.innerHTML = '';
  const [catLabel, catColor, catBg] = TYPE_META[type].cat(item);

  // 헤더
  const head = el('div', 'drawer-head');
  const chip = el('span', 'cat-chip', catLabel);
  chip.style.color = catColor; chip.style.background = catBg;
  const close = el('button', 'drawer-close', '✕');
  close.addEventListener('click', closeDrawer);
  head.append(chip, close);
  d.appendChild(head);

  // 제목 / 시간
  d.appendChild(el('div', 'drawer-title', item.title || item.text || ''));
  const timeText = type === 'task' ? (item.deadline ? '기한 ' + fmtMD(item.deadline) : '기한 미정')
    : type === 'agenda' ? `${fmtMD(item.date)} · ${item.start_time}${item.end_time ? ' – ' + item.end_time : ''}`
    : type === 'client' ? (item.next_meeting ? '다음 미팅 ' + fmtMD(item.next_meeting) : '미팅 미정')
    : '개선 아이디어';
  d.appendChild(el('div', 'drawer-time', timeText));

  // 상태 칩
  if (type === 'task' || (type === 'agenda' && item.urgent)) {
    const s = type === 'task' ? item.status : '진행 예정';
    const st = statusStyle(s);
    const sc = el('span', 'status-chip', s);
    sc.style.color = st.color; sc.style.background = st.bg;
    d.appendChild(sc);
  }

  // 진행률 (클라이언트)
  if (type === 'client') {
    const prog = progressOf('client', item.id);
    const pw = el('div', 'progress-wrap');
    const label = el('div', 'drawer-section-title', `진행률 ${prog}%`);
    const bg = el('div', 'progress-bg');
    const bar = el('div', 'progress-bar');
    bar.style.width = prog + '%'; bar.style.background = item.color;
    bg.appendChild(bar);
    pw.append(label, bg);
    d.appendChild(pw);
  }

  // 정보 행
  const rows = [];
  if (type === 'task') rows.push(['담당자', item.assignee || '미지정'], ['기한', fmtMD(item.deadline) || '미정'], ['클라이언트', item.client]);
  if (type === 'agenda') rows.push(['장소', item.location || '-'], ['참석', item.attendees || '-'], ['클라이언트', item.client]);
  if (type === 'client') rows.push(['PM', item.pm || '미지정'], ['다음 미팅', fmtMD(item.next_meeting) || '미정'], ['마감', item.deadline ? `${fmtMD(item.deadline)} (${ddayText(item.deadline)})` : '미정']);
  if (type === 'memo') rows.push(['분류', '개선 사항'], ['상태', item.done ? '완료' : '대기']);
  const rowWrap = el('div', 'drawer-rows');
  rows.forEach(([lbl, val]) => {
    const r = el('div', 'drawer-row');
    r.appendChild(el('span', 'lbl', lbl));
    r.appendChild(el('span', 'val', val));
    rowWrap.appendChild(r);
  });
  d.appendChild(rowWrap);

  // 설명
  if (item.description) d.appendChild(el('div', 'drawer-desc', item.description));

  // 체크리스트 (task / client)
  if (type === 'task' || type === 'client') {
    d.appendChild(el('div', 'drawer-section-title', '체크리스트'));
    const listWrap = el('div', 'check-list');
    const items = checklistOf(type, item.id);
    items.forEach(c => {
      const ci = el('div', 'check-item');
      const box = el('span', 'check-box' + (c.done ? ' done' : ''), c.done ? '✓' : '');
      const txt = el('span', 'check-text' + (c.done ? ' done' : ''), c.text);
      ci.append(box, txt);
      ci.addEventListener('click', async () => {
        const { error } = await sb.from('checklist_items').update({ done: !c.done }).eq('id', c.id);
        if (error) toast('변경 권한이 없습니다.'); else loadAll();
      });
      if (canEdit(type, item)) {
        const del = el('button', 'check-del', '삭제');
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          const { error } = await sb.from('checklist_items').delete().eq('id', c.id);
          if (error) toast('삭제 권한이 없습니다.'); else loadAll();
        });
        ci.appendChild(del);
      }
      listWrap.appendChild(ci);
    });
    d.appendChild(listWrap);

    if (canEdit(type, item)) {
      const addWrap = el('div', 'check-add');
      const input = el('input');
      input.placeholder = '체크리스트 항목 추가';
      const btn = el('button', null, '추가');
      const add = async () => {
        const text = input.value.trim();
        if (!text) return;
        const { error } = await sb.from('checklist_items').insert({
          parent_type: type, parent_id: item.id, text,
          sort: checklistOf(type, item.id).length
        });
        if (error) toast('추가 권한이 없습니다.');
        else { input.value = ''; loadAll(); }
      };
      btn.addEventListener('click', add);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
      addWrap.append(input, btn);
      d.appendChild(addWrap);
    }
  }

  // 액션 버튼
  if (canEdit(type, item)) {
    const actions = el('div', 'drawer-actions');
    const editBtn = el('button', 'btn btn-primary', '편집');
    editBtn.addEventListener('click', () => { drawerState = { mode: 'edit', type, id }; renderDrawerForm(); });
    const delBtn = el('button', 'btn btn-danger', '삭제');
    delBtn.addEventListener('click', async () => {
      if (!confirm('정말 삭제할까요?')) return;
      if (type === 'task' || type === 'client') {
        await sb.from('checklist_items').delete().eq('parent_type', type).eq('parent_id', id);
      }
      const { error } = await sb.from(TYPE_META[type].table).delete().eq('id', id);
      if (error) toast('삭제 권한이 없습니다.');
      else { closeDrawer(); loadAll(); toast('삭제했습니다.'); }
    });
    actions.append(editBtn, delBtn);
    d.appendChild(actions);
  }
}

// ---------- 편집 / 신규 폼 ----------
function field(label, node) {
  const f = el('div', 'form-field');
  f.appendChild(el('label', null, label));
  f.appendChild(node);
  return f;
}
function textInput(value, placeholder) {
  const i = el('input');
  i.value = value || '';
  if (placeholder) i.placeholder = placeholder;
  return i;
}
function dateInput(value) {
  const i = el('input');
  i.type = 'date';
  i.value = value || '';
  return i;
}
function selectInput(options, value) {
  const s = el('select');
  options.forEach(o => {
    const op = el('option', null, o);
    op.value = o;
    if (o === value) op.selected = true;
    s.appendChild(op);
  });
  return s;
}
function colorPicker(colors, value) {
  const wrap = el('div', 'color-row');
  wrap.dataset.value = value || colors[0];
  colors.forEach(c => {
    const sw = el('div', 'color-swatch' + (c === wrap.dataset.value ? ' selected' : ''));
    sw.style.background = c;
    sw.addEventListener('click', () => {
      wrap.dataset.value = c;
      wrap.querySelectorAll('.color-swatch').forEach(x => x.classList.remove('selected'));
      sw.classList.add('selected');
    });
    wrap.appendChild(sw);
  });
  return wrap;
}

function renderDrawerForm() {
  const { type, id, mode, scope } = drawerState;
  const isNew = mode === 'new';
  const item = isNew ? {} : (findItem(type, id) || {});
  const d = $('drawer');
  d.innerHTML = '';

  const titles = { task: '업무', client: '클라이언트 프로젝트', agenda: '일정', memo: '메모' };
  const head = el('div', 'drawer-head');
  head.appendChild(el('div', 'drawer-title', (isNew ? '새 ' : '') + titles[type] + (isNew ? ' 추가' : ' 편집')));
  const close = el('button', 'drawer-close', '✕');
  close.addEventListener('click', closeDrawer);
  head.appendChild(close);
  d.appendChild(head);

  const f = {};
  if (type === 'task') {
    f.title = textInput(item.title, '업무 제목');
    f.assignee = textInput(item.assignee, '담당자 이름');
    f.deadline = dateInput(item.deadline);
    f.status = selectInput(STATUS_OPTIONS, item.status || '대기');
    f.client = textInput(item.client || '내부', '내부 / A사 …');
    f.description = el('textarea'); f.description.value = item.description || '';
    d.appendChild(field('업무', f.title));
    const two = el('div', 'form-2col');
    two.appendChild(field('담당자', f.assignee));
    two.appendChild(field('기한', f.deadline));
    d.appendChild(two);
    const two2 = el('div', 'form-2col');
    two2.appendChild(field('상태', f.status));
    two2.appendChild(field('클라이언트', f.client));
    d.appendChild(two2);
    d.appendChild(field('설명', f.description));
  }
  if (type === 'agenda') {
    f.title = textInput(item.title, '일정 제목');
    f.date = dateInput(item.date || selectedDate);
    f.start = textInput(item.start_time, '09:30'); f.start.type = 'time'; f.start.value = item.start_time || '';
    f.end = textInput(item.end_time, '10:00'); f.end.type = 'time'; f.end.value = item.end_time || '';
    f.color = colorPicker(EVENT_COLORS, item.color);
    f.urgent = el('input'); f.urgent.type = 'checkbox'; f.urgent.checked = !!item.urgent;
    f.location = textInput(item.location, '대회의실 / Zoom …');
    f.attendees = textInput(item.attendees, '참석자');
    f.client = textInput(item.client || '내부');
    f.description = el('textarea'); f.description.value = item.description || '';
    d.appendChild(field('일정', f.title));
    d.appendChild(field('날짜', f.date));
    const two = el('div', 'form-2col');
    two.appendChild(field('시작', f.start));
    two.appendChild(field('종료', f.end));
    d.appendChild(two);
    d.appendChild(field('색상', f.color));
    const urgentWrap = el('div');
    urgentWrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px;';
    urgentWrap.appendChild(f.urgent);
    urgentWrap.appendChild(document.createTextNode('긴급 일정으로 표시'));
    d.appendChild(field('긴급', urgentWrap));
    const two2 = el('div', 'form-2col');
    two2.appendChild(field('장소', f.location));
    two2.appendChild(field('참석', f.attendees));
    d.appendChild(two2);
    d.appendChild(field('클라이언트', f.client));
    d.appendChild(field('설명', f.description));
  }
  if (type === 'client') {
    f.name = textInput(item.name, '프로젝트명');
    f.badge = textInput(item.badge, 'A'); f.badge.maxLength = 2;
    f.color = colorPicker(EVENT_COLORS, item.color);
    f.pm = textInput(item.pm, 'PM 이름');
    f.next = dateInput(item.next_meeting);
    f.deadline = dateInput(item.deadline);
    f.description = el('textarea'); f.description.value = item.description || '';
    d.appendChild(field('프로젝트명', f.name));
    const two = el('div', 'form-2col');
    two.appendChild(field('배지 문자', f.badge));
    two.appendChild(field('PM', f.pm));
    d.appendChild(two);
    d.appendChild(field('색상', f.color));
    const two2 = el('div', 'form-2col');
    two2.appendChild(field('다음 미팅', f.next));
    two2.appendChild(field('마감', f.deadline));
    d.appendChild(two2);
    d.appendChild(field('설명', f.description));
  }
  if (type === 'memo') {
    f.text = textInput(item.text, '개선 사항');
    f.description = el('textarea'); f.description.value = item.description || '';
    d.appendChild(field('제목', f.text));
    d.appendChild(field('설명', f.description));
  }

  const actions = el('div', 'drawer-actions');
  const save = el('button', 'btn btn-primary', isNew ? '추가' : '저장');
  save.addEventListener('click', async () => {
    let payload;
    if (type === 'task') payload = {
      scope: item.scope || scope || 'staff',
      title: f.title.value.trim(), assignee: f.assignee.value.trim(),
      deadline: f.deadline.value || null, status: f.status.value,
      client: f.client.value.trim() || '내부', description: f.description.value.trim()
    };
    if (type === 'agenda') payload = {
      title: f.title.value.trim(), date: f.date.value,
      start_time: f.start.value, end_time: f.end.value,
      color: f.color.dataset.value, urgent: f.urgent.checked,
      location: f.location.value.trim(), attendees: f.attendees.value.trim(),
      client: f.client.value.trim() || '내부', description: f.description.value.trim()
    };
    if (type === 'client') payload = {
      name: f.name.value.trim(), badge: (f.badge.value.trim() || 'N').toUpperCase(),
      color: f.color.dataset.value, pm: f.pm.value.trim(),
      next_meeting: f.next.value || null, deadline: f.deadline.value || null,
      description: f.description.value.trim()
    };
    if (type === 'memo') payload = { text: f.text.value.trim(), description: f.description.value.trim() };

    const required = payload.title ?? payload.name ?? payload.text;
    if (!required) { toast('제목을 입력하세요.'); return; }
    if (type === 'agenda' && !payload.date) { toast('날짜를 선택하세요.'); return; }

    save.disabled = true;
    const table = TYPE_META[type].table;
    const q = isNew
      ? sb.from(table).insert(payload).select().single()
      : sb.from(table).update(payload).eq('id', id).select().single();
    const { data, error } = await q;
    save.disabled = false;
    if (error) { toast('저장 권한이 없거나 오류가 발생했습니다.'); return; }
    toast(isNew ? '추가했습니다.' : '저장했습니다.');
    await loadAll();
    drawerState = { mode: 'view', type, id: data.id };
    refreshDrawerView();
  });
  const cancel = el('button', 'btn btn-ghost', '취소');
  cancel.addEventListener('click', () => {
    if (isNew) closeDrawer();
    else { drawerState = { mode: 'view', type, id }; refreshDrawerView(); }
  });
  actions.append(save, cancel);
  d.appendChild(actions);
}

/* =====================================================================
 * 회원 관리 (관리자 전용) — Edge Function 'admin-users' 호출
 * service_role 키는 서버(Edge Function)에만 있으므로 exe에서 안전합니다.
 * ===================================================================== */
async function callAdminUsers(payload) {
  const { data, error } = await sb.functions.invoke('admin-users', { body: payload });
  if (error) {
    // Edge Function이 4xx/5xx로 응답하면 본문에서 메시지 추출 시도
    let msg = '요청을 처리하지 못했습니다.';
    try {
      const ctx = await error.context?.json?.();
      if (ctx?.error) msg = ctx.error;
    } catch {}
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

function openMembersPanel() {
  drawerState = { mode: 'members' };
  $('drawer').classList.add('open');
  $('drawer-backdrop').classList.add('open');
  renderMembersPanel();
}

async function renderMembersPanel() {
  const d = $('drawer');
  d.innerHTML = '';

  const head = el('div', 'drawer-head');
  head.appendChild(el('div', 'drawer-title', '회원 관리'));
  const close = el('button', 'drawer-close', '✕');
  close.addEventListener('click', closeDrawer);
  head.appendChild(close);
  d.appendChild(head);

  // ---- 새 계정 발급 폼 ----
  const form = el('div', 'member-form');
  form.appendChild(el('div', 'member-form-title', '새 계정 발급'));
  const email = textInput('', 'name@company.com');
  email.type = 'email';
  const pw = textInput('', '초기 비밀번호 (6자 이상)');
  pw.type = 'password';
  const name = textInput('', '표시 이름 (예: 김도현)');
  const role = selectInput(['staff', 'admin'], 'staff');
  role.querySelector('option[value="staff"]').textContent = '일반 직원';
  role.querySelector('option[value="admin"]').textContent = '관리자';

  form.appendChild(field('이메일', email));
  const two = el('div', 'form-2col');
  two.appendChild(field('비밀번호', pw));
  two.appendChild(field('역할', role));
  form.appendChild(two);
  form.appendChild(field('이름', name));

  const createBtn = el('button', 'btn btn-primary', '계정 생성');
  createBtn.addEventListener('click', async () => {
    if (!email.value.trim() || !pw.value) { toast('이메일과 비밀번호를 입력하세요.'); return; }
    createBtn.disabled = true;
    try {
      await callAdminUsers({
        action: 'create',
        email: email.value.trim(),
        password: pw.value,
        name: name.value.trim(),
        role: role.value
      });
      toast('계정을 발급했습니다.');
      renderMembersPanel();
    } catch (e) {
      toast(e.message);
      createBtn.disabled = false;
    }
  });
  form.appendChild(createBtn);
  d.appendChild(form);

  // ---- 회원 목록 ----
  d.appendChild(el('div', 'drawer-section-title', '전체 회원'));
  const listWrap = el('div', 'member-list');
  listWrap.appendChild(el('div', 'empty-note', '불러오는 중…'));
  d.appendChild(listWrap);

  let users;
  try {
    ({ users } = await callAdminUsers({ action: 'list' }));
  } catch (e) {
    listWrap.innerHTML = '';
    listWrap.appendChild(el('div', 'empty-note',
      '목록을 불러오지 못했습니다: ' + e.message +
      ' — Edge Function(admin-users)이 배포되어 있는지 확인하세요.'));
    return;
  }

  listWrap.innerHTML = '';
  users.sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'admin' ? -1 : 1));
  users.forEach(u => {
    const row = el('div', 'member-row');

    const info = el('div', 'member-info');
    info.appendChild(el('div', 'member-name', u.name || '(이름 없음)'));
    info.appendChild(el('div', 'member-email', u.email));
    row.appendChild(info);

    // 역할 변경
    const roleSel = selectInput(['staff', 'admin'], u.role);
    roleSel.querySelector('option[value="staff"]').textContent = '일반 직원';
    roleSel.querySelector('option[value="admin"]').textContent = '관리자';
    if (u.id === me.id) roleSel.disabled = true; // 본인 권한 해제 방지
    roleSel.addEventListener('change', async () => {
      try {
        await callAdminUsers({ action: 'update_profile', id: u.id, role: roleSel.value });
        toast('역할을 변경했습니다.');
      } catch (e) { toast(e.message); roleSel.value = u.role; }
    });
    row.appendChild(roleSel);

    // 비밀번호 재설정
    const pwBtn = el('button', 'mini-btn', '비밀번호');
    pwBtn.addEventListener('click', async () => {
      const np = prompt(`${u.name || u.email} 의 새 비밀번호 (6자 이상):`);
      if (!np) return;
      try {
        await callAdminUsers({ action: 'set_password', id: u.id, password: np });
        toast('비밀번호를 변경했습니다.');
      } catch (e) { toast(e.message); }
    });
    row.appendChild(pwBtn);

    // 삭제
    if (u.id !== me.id) {
      const delBtn = el('button', 'mini-btn danger', '삭제');
      delBtn.addEventListener('click', async () => {
        if (!confirm(`${u.name || u.email} 계정을 삭제할까요? 되돌릴 수 없습니다.`)) return;
        try {
          await callAdminUsers({ action: 'delete', id: u.id });
          toast('계정을 삭제했습니다.');
          renderMembersPanel();
        } catch (e) { toast(e.message); }
      });
      row.appendChild(delBtn);
    }

    listWrap.appendChild(row);
  });
}
