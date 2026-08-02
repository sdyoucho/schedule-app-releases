// =====================================================================
// Supabase → Notion 열람용 동기화 스크립트
// GitHub Actions에서 매일 자동 실행됩니다 (수동 실행도 가능).
// 외부 패키지 없이 Node 20 내장 fetch만 사용합니다.
//
// 필요한 환경변수 (GitHub 저장소 Secrets에 등록):
//   SUPABASE_URL          예: https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  Supabase secret 키 (sb_secret_... 또는 legacy service_role)
//   NOTION_TOKEN          Notion 통합(Integration) 토큰 (ntn_... / secret_...)
//   NOTION_PAGE_ID        동기화 대상 Notion 페이지 ID (통합이 연결되어 있어야 함)
// =====================================================================
'use strict';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, NOTION_TOKEN, NOTION_PAGE_ID } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, NOTION_TOKEN, NOTION_PAGE_ID })) {
  if (!v) { console.error(`환경변수 ${k} 가 설정되지 않았습니다.`); process.exit(1); }
}

// ---------------- Supabase REST ----------------
async function sbTable(table) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase ${table} 조회 실패: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---------------- Notion API ----------------
async function notion(path, method = 'GET', body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Notion ${method} ${path} 실패: ${data.message || res.status}`);
  return data;
}

const rt = (s) => [{ type: 'text', text: { content: String(s ?? '').slice(0, 1900) } }];
const title = (s) => ({ title: rt(s || '(제목 없음)') });
const text = (s) => ({ rich_text: s ? rt(s) : [] });
const date = (d) => ({ date: d ? { start: d } : null });
const sel = (s) => ({ select: s ? { name: String(s).slice(0, 90) } : null });
const num = (n) => ({ number: typeof n === 'number' ? n : null });
const chk = (b) => ({ checkbox: !!b });

// ---------------- 데이터베이스 찾기/생성 ----------------
async function findOrCreateDatabase(dbTitle, properties) {
  // 부모 페이지의 자식 블록에서 같은 제목의 데이터베이스 검색
  let cursor;
  do {
    const res = await notion(`/blocks/${NOTION_PAGE_ID}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    for (const block of res.results) {
      if (block.type === 'child_database' && block.child_database.title === dbTitle) {
        return block.id;
      }
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  const created = await notion('/databases', 'POST', {
    parent: { type: 'page_id', page_id: NOTION_PAGE_ID },
    title: rt(dbTitle),
    properties
  });
  console.log(`데이터베이스 생성: ${dbTitle}`);
  return created.id;
}

// ---------------- 업서트 (SyncID 기준) ----------------
async function queryAllPages(dbId) {
  const pages = [];
  let cursor;
  do {
    const res = await notion(`/databases/${dbId}/query`, 'POST', {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {})
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return pages;
}

async function syncDatabase(dbTitle, schema, rows, buildProps) {
  const dbId = await findOrCreateDatabase(dbTitle, schema);
  const existing = await queryAllPages(dbId);
  const byId = new Map();
  for (const p of existing) {
    const sid = p.properties.SyncID?.rich_text?.[0]?.plain_text;
    if (sid) byId.set(sid, p);
  }

  let created = 0, updated = 0, archived = 0;
  const liveIds = new Set();

  for (const row of rows) {
    liveIds.add(row.id);
    const props = { ...buildProps(row), SyncID: text(row.id) };
    const page = byId.get(row.id);
    if (page) {
      await notion(`/pages/${page.id}`, 'PATCH', { properties: props });
      updated++;
    } else {
      await notion('/pages', 'POST', { parent: { database_id: dbId }, properties: props });
      created++;
    }
  }
  // 원본에서 삭제된 항목은 보관(archive) 처리
  for (const [sid, page] of byId) {
    if (!liveIds.has(sid) && !page.archived) {
      await notion(`/pages/${page.id}`, 'PATCH', { archived: true });
      archived++;
    }
  }
  console.log(`${dbTitle}: 생성 ${created} / 갱신 ${updated} / 보관 ${archived}`);
}

// ---------------- 메인 ----------------
(async () => {
  const [tasks, clients, agenda, memos, checklist] = await Promise.all([
    sbTable('tasks'), sbTable('clients'), sbTable('agenda'), sbTable('memos'), sbTable('checklist_items')
  ]);

  const checkSummary = (type, id) => {
    const items = checklist
      .filter(c => c.parent_type === type && c.parent_id === id)
      .sort((a, b) => a.sort - b.sort);
    if (!items.length) return '';
    const done = items.filter(c => c.done).length;
    const list = items.map(c => `${c.done ? '✓' : '○'} ${c.text}`).join(' · ');
    return `${done}/${items.length} 완료 — ${list}`;
  };
  const progress = (type, id) => {
    const items = checklist.filter(c => c.parent_type === type && c.parent_id === id);
    return items.length ? Math.round(items.filter(c => c.done).length / items.length * 100) : 0;
  };

  await syncDatabase('업무', {
    Name: { title: {} }, 구분: { select: {} }, 담당자: { rich_text: {} },
    기한: { date: {} }, 상태: { select: {} }, 클라이언트: { rich_text: {} },
    진행률: { number: { format: 'percent' } }, 체크리스트: { rich_text: {} },
    설명: { rich_text: {} }, SyncID: { rich_text: {} }
  }, tasks, (t) => ({
    Name: title(t.title),
    구분: sel(t.scope === 'admin' ? '관리자' : '직원'),
    담당자: text(t.assignee),
    기한: date(t.deadline),
    상태: sel(t.status),
    클라이언트: text(t.client),
    진행률: num(progress('task', t.id) / 100),
    체크리스트: text(checkSummary('task', t.id)),
    설명: text(t.description)
  }));

  await syncDatabase('일정', {
    Name: { title: {} }, 날짜: { date: {} }, 시간: { rich_text: {} },
    긴급: { checkbox: {} }, 장소: { rich_text: {} }, 참석: { rich_text: {} },
    클라이언트: { rich_text: {} }, 설명: { rich_text: {} }, SyncID: { rich_text: {} }
  }, agenda, (a) => ({
    Name: title(a.title),
    날짜: date(a.date),
    시간: text(a.start_time ? `${a.start_time}${a.end_time ? ' – ' + a.end_time : ''}` : ''),
    긴급: chk(a.urgent),
    장소: text(a.location),
    참석: text(a.attendees),
    클라이언트: text(a.client),
    설명: text(a.description)
  }));

  await syncDatabase('클라이언트', {
    Name: { title: {} }, PM: { rich_text: {} }, '다음 미팅': { date: {} },
    마감: { date: {} }, 진행률: { number: { format: 'percent' } },
    체크리스트: { rich_text: {} }, 설명: { rich_text: {} }, SyncID: { rich_text: {} }
  }, clients, (c) => ({
    Name: title(c.name),
    PM: text(c.pm),
    '다음 미팅': date(c.next_meeting),
    마감: date(c.deadline),
    진행률: num(progress('client', c.id) / 100),
    체크리스트: text(checkSummary('client', c.id)),
    설명: text(c.description)
  }));

  await syncDatabase('메모', {
    Name: { title: {} }, 완료: { checkbox: {} }, 설명: { rich_text: {} }, SyncID: { rich_text: {} }
  }, memos, (m) => ({
    Name: title(m.text),
    완료: chk(m.done),
    설명: text(m.description)
  }));

  console.log('Notion 동기화 완료:', new Date().toISOString());
})().catch((e) => { console.error(e.message); process.exit(1); });
