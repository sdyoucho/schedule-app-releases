-- =====================================================================
-- 관리자 업무(scope='admin') RLS 강화
-- 기존에는 tasks_select / checklist_select / checklist_update 가
-- "로그인만 하면 전원 조회/토글 가능"이라, 일반 직원(staff)도 API를
-- 직접 호출하면 관리자 업무와 그 체크리스트를 읽고 토글할 수 있었습니다.
-- (화면에서만 숨겨져 있었고 DB 레벨 차단은 없었음)
--
-- 적용 방법: Supabase 대시보드 > SQL Editor 에 이 파일 전체를 붙여넣고 Run.
-- schema.sql 전체를 다시 실행할 필요는 없습니다(샘플 데이터 중복 삽입 방지).
-- =====================================================================

-- ---------- tasks: 관리자 업무는 관리자만 조회 ----------
drop policy if exists "tasks_select" on public.tasks;
create policy "tasks_select" on public.tasks for select to authenticated
  using (scope = 'staff' or public.is_admin());

-- ---------- checklist_items: 관리자 업무에 속한 항목은 관리자만 조회/토글 ----------
drop policy if exists "checklist_select" on public.checklist_items;
create policy "checklist_select" on public.checklist_items for select to authenticated
  using (
    parent_type = 'client'
    or (parent_type = 'task' and exists (
      select 1 from public.tasks t where t.id = parent_id and (t.scope = 'staff' or public.is_admin())
    ))
  );

drop policy if exists "checklist_update" on public.checklist_items;
create policy "checklist_update" on public.checklist_items for update to authenticated
  using (
    parent_type = 'client'
    or (parent_type = 'task' and exists (
      select 1 from public.tasks t where t.id = parent_id and (t.scope = 'staff' or public.is_admin())
    ))
  )
  with check (
    parent_type = 'client'
    or (parent_type = 'task' and exists (
      select 1 from public.tasks t where t.id = parent_id and (t.scope = 'staff' or public.is_admin())
    ))
  );
