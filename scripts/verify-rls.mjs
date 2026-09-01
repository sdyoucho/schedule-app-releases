// =====================================================================
// RLS 3-커넥션 검증 스크립트 (anon / staff / admin)
// 로컬(또는 실제 인터넷이 되는 환경)에서 실행하세요:
//
//   STAFF_EMAIL=... STAFF_PASSWORD=... ADMIN_EMAIL=... ADMIN_PASSWORD=... \
//     node scripts/verify-rls.mjs
//
// SUPABASE_URL / SUPABASE_ANON_KEY 는 생략하면 renderer/config.js 에서
// 자동으로 읽어옵니다. 외부 패키지 없이 Node 20 내장 fetch만 사용합니다.
//
// 확인하는 것:
//   1) anon(비로그인)  — tasks/checklist_items 조회 시 0건이어야 함
//   2) staff(일반 직원) — scope='admin' 업무/체크리스트가 절대 보이면 안 됨
//   3) admin(관리자)   — 모든 업무(관리자+직원)가 다 보여야 함
//   4) staff가 admin 업무의 id를 "알고 있어도" 직접 API로 수정/토글이
//      막히는지(응답에서 실제 반영된 행이 0건인지)까지 확인
// =====================================================================
'use strict';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readConfigDefaults() {
  try {
    const src = readFileSync(join(__dirname, '..', 'renderer', 'config.js'), 'utf8');
    const url = src.match(/SUPABASE_URL:\s*'([^']+)'/)?.[1];
    const key = src.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/)?.[1];
    return { url, key };
  } catch {
    return {};
  }
}

const defaults = readConfigDefaults();
const SUPABASE_URL = process.env.SUPABASE_URL || defaults.url;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || defaults.key;
const { STAFF_EMAIL, STAFF_PASSWORD, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('SUPABASE_URL / SUPABASE_ANON_KEY 를 찾을 수 없습니다.');
  process.exit(1);
}
for (const [k, v] of Object.entries({ STAFF_EMAIL, STAFF_PASSWORD, ADMIN_EMAIL, ADMIN_PASSWORD })) {
  if (!v) { console.error(`환경변수 ${k} 가 필요합니다 (테스트용 계정 로그인 정보).`); process.exit(1); }
}

let passCount = 0, failCount = 0;
function report(label, ok, detail) {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  ok ? passCount++ : failCount++;
}

async function login(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`로그인 실패(${email}): ${data.error_description || data.msg || res.status}`);
  return data.access_token;
}

async function select(table, token, query = 'select=*') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token || ANON_KEY}` }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${table} 조회 실패: ${data.message || res.status}`);
  return data;
}

async function patch(table, id, body, token) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: ANON_KEY, Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json', Prefer: 'return=representation'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => []);
  return { ok: res.ok, status: res.status, rows: Array.isArray(data) ? data : [] };
}

async function main() {
  console.log(`\n대상: ${SUPABASE_URL}\n`);

  // ---------- 1) anon ----------
  const anonTasks = await select('tasks', null);
  report('[anon] tasks 조회 결과가 0건', anonTasks.length === 0, `실제 ${anonTasks.length}건`);
  const anonChecklist = await select('checklist_items', null);
  report('[anon] checklist_items 조회 결과가 0건', anonChecklist.length === 0, `실제 ${anonChecklist.length}건`);

  // ---------- 로그인 ----------
  const staffToken = await login(STAFF_EMAIL, STAFF_PASSWORD);
  const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

  // ---------- 2) staff ----------
  const staffTasks = await select('tasks', staffToken);
  const staffSeesAdminTask = staffTasks.some(t => t.scope === 'admin');
  report('[staff] 관리자 업무(scope=admin)가 하나도 안 보임', !staffSeesAdminTask,
    `staff에게 보인 업무 ${staffTasks.length}건 중 admin scope ${staffTasks.filter(t => t.scope === 'admin').length}건`);

  // ---------- 3) admin ----------
  const adminTasks = await select('tasks', adminToken);
  const adminScopeTasks = adminTasks.filter(t => t.scope === 'admin');
  report('[admin] 전체 업무 조회 가능(직원 업무 수 이상)', adminTasks.length >= staffTasks.length,
    `admin ${adminTasks.length}건 / staff ${staffTasks.length}건`);
  report('[admin] 관리자 업무(scope=admin)가 보임', adminScopeTasks.length > 0,
    adminScopeTasks.length > 0 ? `${adminScopeTasks.length}건` : '관리자 업무가 DB에 없어 이 항목은 검증 불가(스킵으로 간주)');

  const adminChecklist = await select('checklist_items', adminToken);
  const adminTaskIds = new Set(adminScopeTasks.map(t => t.id));
  const adminScopeChecklist = adminChecklist.filter(c => c.parent_type === 'task' && adminTaskIds.has(c.parent_id));
  const staffChecklist = await select('checklist_items', staffToken);
  const staffSeesAdminChecklist = staffChecklist.some(c => c.parent_type === 'task' && adminTaskIds.has(c.parent_id));
  report('[staff] 관리자 업무의 체크리스트가 하나도 안 보임', !staffSeesAdminChecklist,
    `admin 업무에 속한 체크리스트 ${adminScopeChecklist.length}건 중 staff에게 보인 것 ${staffChecklist.filter(c => c.parent_type === 'task' && adminTaskIds.has(c.parent_id)).length}건`);

  // ---------- 4) staff가 admin 업무 id를 "알고 있어도" 직접 수정이 막히는지 ----------
  if (adminScopeTasks.length > 0) {
    const target = adminScopeTasks[0];
    const { rows } = await patch('tasks', target.id, { status: '완료' }, staffToken);
    report('[staff→admin업무] 직접 PATCH 시도 시 실제 반영 0건(차단됨)', rows.length === 0,
      rows.length === 0 ? '차단됨' : `${rows.length}건이 수정되어버림 — 취약점!`);
  } else {
    console.log('ℹ️  admin scope 업무가 DB에 없어 4번 쓰기-차단 테스트는 스킵했습니다.');
  }

  console.log(`\n총 ${passCount + failCount}건 중 PASS ${passCount} / FAIL ${failCount}\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(e => { console.error('스크립트 오류:', e.message); process.exit(1); });
