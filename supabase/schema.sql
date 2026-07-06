-- =====================================================================
-- 회사 스케줄 관리 — Supabase 스키마
-- Supabase 대시보드 > SQL Editor 에 전체 붙여넣기 후 Run 하세요.
-- =====================================================================

-- ---------- 1. 프로필 (역할 관리) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  role text not null default 'staff' check (role in ('admin', 'staff')),
  created_at timestamptz not null default now()
);

-- 신규 유저 생성 시 프로필 자동 생성 (기본 역할: staff)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    'staff'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 현재 유저가 관리자인지 확인하는 헬퍼
create or replace function public.is_admin()
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ---------- 2. 업무 (관리자 전용 / 직원 전용) ----------
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  scope text not null default 'staff' check (scope in ('admin', 'staff')),
  title text not null,
  assignee text not null default '',
  deadline date,
  status text not null default '대기',
  client text not null default '내부',
  description text not null default '',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- ---------- 3. 클라이언트 프로젝트 ----------
create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  badge text not null default 'N',
  name text not null,
  color text not null default '#0A84FF',
  pm text not null default '',
  next_meeting date,
  deadline date,
  description text not null default '',
  created_at timestamptz not null default now()
);

-- ---------- 4. 일정 (오늘 일정 / 캘린더) ----------
create table if not exists public.agenda (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  start_time text not null default '',
  end_time text not null default '',
  title text not null,
  color text not null default '#0A84FF',
  urgent boolean not null default false,
  location text not null default '',
  attendees text not null default '',
  client text not null default '내부',
  description text not null default '',
  created_at timestamptz not null default now()
);

-- ---------- 5. 메모 (회사 개선 사항) ----------
create table if not exists public.memos (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  description text not null default '',
  done boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- 6. 체크리스트 ----------
create table if not exists public.checklist_items (
  id uuid primary key default gen_random_uuid(),
  parent_type text not null check (parent_type in ('task', 'client')),
  parent_id uuid not null,
  text text not null,
  done boolean not null default false,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_checklist_parent on public.checklist_items(parent_type, parent_id);

-- =====================================================================
-- RLS (행 수준 보안) — 로그인한 사용자만 접근, 역할별 쓰기 권한 분리
-- =====================================================================
alter table public.profiles        enable row level security;
alter table public.tasks           enable row level security;
alter table public.clients         enable row level security;
alter table public.agenda          enable row level security;
alter table public.memos           enable row level security;
alter table public.checklist_items enable row level security;

-- 프로필: 전원 조회 가능(이름 표시용), 본인 이름 수정 가능, 역할 변경은 관리자만
create policy "profiles_select" on public.profiles for select to authenticated using (true);
create policy "profiles_update_self" on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- 업무: 전원 조회. 관리자 업무(scope='admin')는 관리자만 쓰기, 직원 업무는 전원 쓰기
create policy "tasks_select" on public.tasks for select to authenticated using (true);
create policy "tasks_insert" on public.tasks for insert to authenticated
  with check (public.is_admin() or scope = 'staff');
create policy "tasks_update" on public.tasks for update to authenticated
  using (public.is_admin() or scope = 'staff')
  with check (public.is_admin() or scope = 'staff');
create policy "tasks_delete" on public.tasks for delete to authenticated
  using (public.is_admin() or scope = 'staff');

-- 클라이언트: 전원 조회, 쓰기는 관리자만
create policy "clients_select" on public.clients for select to authenticated using (true);
create policy "clients_write" on public.clients for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- 일정: 전원 조회/쓰기
create policy "agenda_select" on public.agenda for select to authenticated using (true);
create policy "agenda_write" on public.agenda for all to authenticated
  using (true) with check (true);

-- 메모: 전원 조회, 쓰기는 관리자만 (디자인상 관리자 전용 카드 내부)
create policy "memos_select" on public.memos for select to authenticated using (true);
create policy "memos_write" on public.memos for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- 체크리스트: 전원 조회, 체크 토글은 전원 가능.
-- 추가/삭제는 관리자 또는 (직원 업무에 속한 항목)만 가능
create policy "checklist_select" on public.checklist_items for select to authenticated using (true);
create policy "checklist_update" on public.checklist_items for update to authenticated
  using (true) with check (true);
create policy "checklist_insert" on public.checklist_items for insert to authenticated
  with check (
    public.is_admin()
    or (parent_type = 'task' and exists (
      select 1 from public.tasks t where t.id = parent_id and t.scope = 'staff'
    ))
  );
create policy "checklist_delete" on public.checklist_items for delete to authenticated
  using (
    public.is_admin()
    or (parent_type = 'task' and exists (
      select 1 from public.checklist_items c
      join public.tasks t on t.id = c.parent_id
      where c.id = checklist_items.id and c.parent_type = 'task' and t.scope = 'staff'
    ))
  );

-- 실시간 동기화 활성화
do $$
begin
  begin
    alter publication supabase_realtime add table public.tasks;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table public.clients;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table public.agenda;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table public.memos;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table public.checklist_items;
  exception when duplicate_object then null; end;
end $$;

-- =====================================================================
-- (선택) 샘플 데이터 — 디자인 시안과 동일한 예시. 필요 없으면 이 아래는 실행하지 마세요.
-- =====================================================================
insert into public.tasks (scope, title, assignee, deadline, status, client, description) values
('admin', '3분기 예산 확정', '이지훈', '2026-07-10', '진행중', '내부', '3분기 부서별 예산안 취합 및 최종 확정. 재무팀 검토 후 임원 승인이 필요합니다.'),
('admin', '임원 워크숍 기획', '박서연', '2026-07-18', '대기', '내부', '하반기 전략 수립을 위한 임원 워크숍 기획. 장소 섭외와 아젠다 구성이 핵심입니다.'),
('admin', '상반기 인사 평가', '김도현', '2026-07-05', '완료', '내부', '상반기 전 직원 인사 평가 마무리. 평가 결과 피드백 면담까지 완료되었습니다.'),
('staff', '랜딩 페이지 디자인', '최유진', '2026-07-08', '진행중', 'A사', 'A사 리브랜딩 랜딩 페이지 시안 작업. 히어로 섹션과 반응형 레이아웃 우선 진행 중입니다.'),
('staff', '주간 리포트 작성', '정민수', '2026-07-07', '지연', '내부', '전 부서 주간 실적 리포트 작성. 일부 부서 데이터 취합이 지연되고 있습니다.'),
('staff', '고객 문의 응대 정리', '한소희', '2026-07-06', '완료', 'C사', 'C사 광고 캠페인 관련 고객 문의 응대 내역 정리 및 FAQ 업데이트를 완료했습니다.');

insert into public.clients (badge, name, color, pm, next_meeting, deadline, description) values
('A', 'A사 리브랜딩', '#0A84FF', '이지훈', '2026-07-06', '2026-07-06', 'A사 브랜드 아이덴티티 전면 리뉴얼. 로고, 컬러 시스템, 웹사이트까지 포함하는 통합 리브랜딩입니다.'),
('B', 'B사 앱 개발', '#30A46C', '정민수', '2026-07-12', '2026-07-12', 'B사 모바일 앱 신규 개발. 현재 핵심 기능 개발 단계로 절반 가량 진행되었습니다.'),
('C', 'C사 광고 캠페인', '#FF9500', '한소희', '2026-07-20', '2026-07-20', 'C사 여름 시즌 광고 캠페인. 컨셉 기획 단계이며 크리에이티브 방향을 잡고 있습니다.');

insert into public.agenda (date, start_time, end_time, title, color, urgent, location, attendees, client, description) values
(current_date, '09:30', '10:00', '전사 주간 회의', '#0A84FF', false, '대회의실', '전 팀장', '내부', '전 부서 팀장이 참여하는 주간 정기 회의. 지난 주 실적 공유와 이번 주 우선순위를 정합니다.'),
(current_date, '11:00', '11:30', '신규 프로젝트 킥오프', '#BF5AF2', false, '소회의실 2', '기획·개발', '내부', '신규 내부 프로젝트 착수 미팅. 목표와 역할 분담, 마일스톤을 확정합니다.'),
(current_date, '14:00', '14:30', '서버 점검 대응', '#FF3B30', true, '', '김도현 · 인프라팀', '내부', '메인 API 서버 정기 점검 및 긴급 패치. 서비스 일시 중단 가능성이 있습니다.'),
(current_date, '16:00', '17:00', '클라이언트 A 정기 미팅', '#FF9500', false, '화상 (Zoom)', 'A사 · 디자인팀', 'A사', 'A사 리브랜딩 진행 상황 공유 미팅. 웹사이트 시안 리뷰가 예정되어 있습니다.');

insert into public.memos (text, description) values
('사내 위키 정비', '흩어진 사내 문서를 위키로 통합 정리. 검색성과 최신성 유지가 목표입니다.'),
('온보딩 프로세스 문서화', '신규 입사자 온보딩 절차를 문서화하여 담당자 없이도 진행 가능하게 합니다.'),
('회의실 예약 시스템 개선', '중복 예약과 노쇼가 잦은 회의실 예약 방식을 개선합니다.'),
('복리후생 제도 리뷰', '현행 복리후생 제도의 실사용률을 점검하고 개편안을 검토합니다.');

-- 샘플 체크리스트
insert into public.checklist_items (parent_type, parent_id, text, done, sort)
select 'task', id, v.text, v.done, v.sort from public.tasks t,
lateral (values
  ('부서별 예산안 취합', true, 0), ('재무 검토', false, 1), ('임원 승인', false, 2)
) as v(text, done, sort)
where t.title = '3분기 예산 확정';

insert into public.checklist_items (parent_type, parent_id, text, done, sort)
select 'task', id, v.text, v.done, v.sort from public.tasks t,
lateral (values
  ('와이어프레임', true, 0), ('히어로 시안', true, 1), ('반응형 대응', false, 2), ('최종 시안 공유', false, 3)
) as v(text, done, sort)
where t.title = '랜딩 페이지 디자인';

insert into public.checklist_items (parent_type, parent_id, text, done, sort)
select 'client', id, v.text, v.done, v.sort from public.clients c,
lateral (values
  ('브랜드 전략', true, 0), ('로고 확정', true, 1), ('웹사이트 디자인', false, 2), ('최종 납품', false, 3)
) as v(text, done, sort)
where c.name = 'A사 리브랜딩';

insert into public.checklist_items (parent_type, parent_id, text, done, sort)
select 'client', id, v.text, v.done, v.sort from public.clients c,
lateral (values
  ('요구사항 정의', true, 0), ('UI 설계', true, 1), ('핵심 기능 개발', false, 2), ('QA', false, 3)
) as v(text, done, sort)
where c.name = 'B사 앱 개발';

insert into public.checklist_items (parent_type, parent_id, text, done, sort)
select 'client', id, v.text, v.done, v.sort from public.clients c,
lateral (values
  ('캠페인 컨셉', true, 0), ('크리에이티브', false, 1), ('매체 집행', false, 2)
) as v(text, done, sort)
where c.name = 'C사 광고 캠페인';
