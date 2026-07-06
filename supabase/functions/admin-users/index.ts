// =====================================================================
// admin-users — 관리자 전용 회원 관리 Edge Function
// service_role 키는 이 서버 함수 안에서만 사용됩니다 (exe에 포함되지 않음).
// 호출자는 로그인한 사용자여야 하며, profiles.role = 'admin' 인 경우에만 허용.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ---- 호출자 검증: 로그인 + 관리자 역할 ----
  const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } = await admin.auth.getUser(jwt);
  if (authErr || !user) return json({ error: "로그인이 필요합니다." }, 401);

  const { data: prof } = await admin.from("profiles").select("role").eq("id", user.id).single();
  if (prof?.role !== "admin") return json({ error: "관리자만 사용할 수 있습니다." }, 403);

  const body = await req.json().catch(() => ({}));
  const action = body.action as string;

  try {
    // ---- 회원 목록 ----
    if (action === "list") {
      const { data: usersData, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (error) throw error;
      const { data: profiles } = await admin.from("profiles").select("*");
      const pmap = new Map((profiles ?? []).map((p) => [p.id, p]));
      const users = usersData.users.map((u) => ({
        id: u.id,
        email: u.email,
        name: pmap.get(u.id)?.name ?? "",
        role: pmap.get(u.id)?.role ?? "staff",
        created_at: u.created_at,
      }));
      return json({ users });
    }

    // ---- 계정 생성 ----
    if (action === "create") {
      const { email, password, name, role } = body;
      if (!email || !password) return json({ error: "이메일과 비밀번호는 필수입니다." }, 400);
      if (password.length < 6) return json({ error: "비밀번호는 6자 이상이어야 합니다." }, 400);

      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name: name || email.split("@")[0] },
      });
      if (error) throw error;

      // 트리거가 프로필을 만들지만, 역할/이름을 명시적으로 반영
      await admin.from("profiles").upsert({
        id: data.user.id,
        name: name || email.split("@")[0],
        role: role === "admin" ? "admin" : "staff",
      });
      return json({ ok: true, id: data.user.id });
    }

    // ---- 비밀번호 재설정 ----
    if (action === "set_password") {
      const { id, password } = body;
      if (!id || !password) return json({ error: "대상과 새 비밀번호가 필요합니다." }, 400);
      if (password.length < 6) return json({ error: "비밀번호는 6자 이상이어야 합니다." }, 400);
      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) throw error;
      return json({ ok: true });
    }

    // ---- 역할/이름 변경 ----
    if (action === "update_profile") {
      const { id, role, name } = body;
      if (!id) return json({ error: "대상이 필요합니다." }, 400);
      if (id === user.id && role && role !== "admin") {
        return json({ error: "본인의 관리자 권한은 해제할 수 없습니다." }, 400);
      }
      const patch: Record<string, string> = {};
      if (role) patch.role = role === "admin" ? "admin" : "staff";
      if (typeof name === "string") patch.name = name;
      const { error } = await admin.from("profiles").update(patch).eq("id", id);
      if (error) throw error;
      return json({ ok: true });
    }

    // ---- 계정 삭제 ----
    if (action === "delete") {
      const { id } = body;
      if (!id) return json({ error: "대상이 필요합니다." }, 400);
      if (id === user.id) return json({ error: "본인 계정은 삭제할 수 없습니다." }, 400);
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "알 수 없는 작업입니다." }, 400);
  } catch (e) {
    return json({ error: (e as Error).message ?? "처리 중 오류가 발생했습니다." }, 500);
  }
});
