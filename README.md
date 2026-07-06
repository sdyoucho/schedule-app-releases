# 회사 스케줄 관리 (Electron + Supabase)

업로드해주신 `회사 스케줄 관리.dc.html` 디자인 기반의 데스크톱(exe) 앱입니다.

- **로그인 필수** — 관리자가 발급한 계정만 접근 (앱 내 회원가입 없음)
- **역할 분리** — 관리자(admin) / 일반 직원(staff), 우측 상단 배지로 표시
- **실시간 공유** — 모든 데이터는 Supabase(무료)에 저장, 전 직원 화면 자동 동기화
- **바탕화면 위젯 모드** — DesktopCal처럼 바탕화면 레이어에 고정 (다른 창 위로 올라오지 않음)
- **앱 내 회원 관리** — 관리자가 앱 안에서 계정 생성 / 비밀번호 재설정 / 역할 변경 / 삭제
- **무설정 배포** — 접속 정보가 빌드에 포함되어, 배포된 exe는 실행만 하면 됨

---

## 1. Supabase 프로젝트 준비 (최초 1회, 관리자만)

1. https://supabase.com → **New project** (리전: Seoul 추천)
2. **SQL Editor** → `supabase/schema.sql` 전체 붙여넣기 → Run
   (하단 "샘플 데이터"가 필요 없으면 그 부분은 지우고 실행)
3. **회원가입 차단**: Authentication → Sign In / Up → *Allow new users to sign up* **OFF**
4. **최초 관리자 1명 생성**: Authentication → Users → Add user (이메일/비밀번호, Auto Confirm 체크)
   → Table Editor → `profiles` → 해당 유저 `role`을 `admin`으로, `name`에 이름 입력
   *(이후 모든 계정 발급은 앱 안의 "회원 관리"에서 하면 됩니다)*

## 2. 회원 관리용 Edge Function 배포 (최초 1회)

앱 내 회원 관리는 service_role 키를 exe에 넣지 않기 위해 서버 함수(Edge Function)로 동작합니다.

**방법 A — 대시보드에서 (CLI 불필요, 추천)**
1. Supabase 대시보드 → **Edge Functions** → *Deploy a new function* → 이름: `admin-users`
2. 에디터에 `supabase/functions/admin-users/index.ts` 내용 붙여넣기 → **Deploy**

**방법 B — CLI로**
```bash
npm i -g supabase
supabase login
supabase functions deploy admin-users --project-ref <프로젝트 REF>
```

배포 후 앱에서 우측 상단 **회원 관리** 버튼(관리자에게만 표시)으로
아이디 생성, 초기 비밀번호 설정, 역할 변경, 비밀번호 재설정, 계정 삭제가 가능합니다.

## 3. 앱 접속 정보 입력 → 빌드 → 무설정 배포

1. `renderer/config.js` 에 입력 (Project Settings → API):
```js
window.APP_CONFIG = {
  SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...'   // anon public 키 (service_role 절대 금지)
};
```
2. 빌드 (Windows + Node.js LTS):
```bash
npm install        # 최초 1회
npm start          # 개발 실행/테스트
npm run dist       # dist/ 에 설치본(nsis) + 무설치(portable) exe 생성
```
3. 생성된 exe를 직원들에게 배포 — **직원은 아무 설정 없이 실행 → 로그인만** 하면 됩니다.
   접속 정보(config.js)가 exe 내부에 포함되기 때문입니다.
   anon 키는 원래 클라이언트 공개용이며, 실제 권한 통제는 DB의 RLS가 담당하므로 안전합니다.

## 4. 바탕화면 위젯 모드 (DesktopCal 방식)

- 우측 상단 **위젯 모드** 버튼 → 창 테두리·작업표시줄 아이콘이 사라지고
  창이 **바탕화면 레이어(항상 맨 아래)에 고정**됩니다.
  클릭해서 일정을 조작해도 다른 창 위로 올라오지 않습니다.
- 상단의 어두운 바를 잡고 드래그하면 위치 이동, 가장자리를 끌면 크기 조절.
  위치/크기는 자동 저장되어 다음 실행 시 그대로 복원됩니다.
- 해제: 상단 바의 **일반 창으로** 버튼, 또는 트레이 아이콘 우클릭 메뉴.
- 위젯 모드에서는 트레이(시계 옆 아이콘)에 상주합니다. 종료도 트레이에서 가능.
- 기술 메모: 창을 맨 아래로 고정하는 데 Windows API(`SetWindowPos`)를 koffi(N-API,
  재빌드 불필요)로 호출합니다. koffi 로드에 실패하는 환경에서는 고정 없이
  테두리 없는 창으로만 동작합니다.

## 5. 권한 설계

| 기능 | 관리자 | 일반 직원 |
|---|---|---|
| 관리자 전용 업무 / 메모 | 관리 | 카드 자체가 표시되지 않음 |
| 직원 전용 업무 | 관리 | 추가·편집·삭제 가능 |
| 오늘 일정 / 긴급 | 관리 | 추가·편집·삭제 가능 |
| 클라이언트 프로젝트 | 관리 | 보기 + 체크리스트 토글만 |
| 회원 관리 (계정 발급 등) | 앱 내 "회원 관리" | 버튼 자체가 표시되지 않음 |

프론트 숨김 + **DB RLS 정책** + **Edge Function의 관리자 검증**으로 이중 삼중 강제됩니다.

## 6. 무료 한도

Supabase Free: DB 500MB / 인증 5만 명 / Edge Function 50만 회 / 실시간 동시접속 200.
단, 1주일간 요청이 없으면 프로젝트가 일시정지되며 대시보드에서 Restore 한 번으로 재개됩니다.

## 7. 파일 구조

```
schedule-app/
├── main.js                  # Electron 메인 (위젯 모드·트레이·창 상태 저장)
├── preload.js               # desktop API (위젯 전환)
├── package.json             # electron-builder + koffi
├── assets/tray.png          # 트레이 아이콘
├── renderer/
│   ├── index.html
│   ├── styles.css
│   ├── app.js               # 인증·권한·CRUD·실시간·회원 관리
│   └── config.js            # ← Supabase URL/anon 키 (빌드에 포함됨)
└── supabase/
    ├── schema.sql           # 테이블 + RLS + 트리거 + 샘플
    └── functions/admin-users/index.ts   # 회원 관리 Edge Function
```
