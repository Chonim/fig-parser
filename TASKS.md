# fig-parser — 남은 작업

`.fig`(ZIP+`canvas.fig`) → 코드 지향 IR → MCP 노출.
목적은 **AI가 디자인을 읽고 정확한 마크업을 쓰게 하는 것**. 픽셀 완벽 뷰어가 아니다.

```
src/parse.mjs     컨테이너 해제, 트리 복원, path blob 디코드
src/ir.mjs        노드 -> IR (아이콘 병합, 인스턴스 확장, 레이아웃 추론, 페인트)
src/html.mjs      IR -> HTML/CSS 기준선 렌더러
src/cli.mjs       node src/cli.mjs <fig> [frame] [outDir]
src/mcp.mjs       MCP 서버 (list_frames / get_frame / get_html / export_assets / get_tokens)
src/census.mjs    미처리 기능 집계 — pnpm census [file]
```

```bash
pnpm test      # parse + components + mcp
pnpm census    # 기본 kyowon-full, 인자로 다른 .fig 지정 가능
```

샘플 2개 모두 gitignore. 없으면 테스트가 skip되므로 **확보 후 시작**.
- `samples/kyowon-full.fig` — 4050노드 12프레임, auto-layout 없음, 컴포넌트 없음
- `samples/matsq.fig` — 7219노드 97프레임, SYMBOL 894 / INSTANCE 947 / auto-layout 1663 / VARIABLE 612

---

## 절대 되돌리지 말 것

테스트로 고정됨. 빨간불이면 원인은 거의 이 넷.

1. **형제 정렬은 바이트 비교.** `parentIndex.position`은 문장부호 fractional index.
   `localeCompare`는 z-order를 무너뜨려 배경이 콘텐츠를 덮는다.
2. **path 좌표는 스케일하지 않는다.** 이미 노드 `size` 공간에 있다.
   `vectorData.normalizedSize`는 좌표계가 아니다. 나누면 아이콘이 점으로 수축.
3. **stroke는 이미 아웃라인.** `strokeGeometry`를 `fillGeometry`와 동일하게 채우고
   paint만 `strokePaints`. CSS `stroke`로 바꾸지 말 것.
4. **`symbolIndex`는 빌드된 트리에서 만든다.** raw `nodeChanges`에는 `children`이 없어서
   마스터가 빈 껍데기로 확장된다.

부동소수점 주의: 행렬은 float32라 회전 없는 노드가 `0.99999994`로 읽힌다. `isIdentity`에 엡실론 필수.

---

## 남은 것

### paint — radial/angular 그라디언트, 다중 fill
`GRADIENT_RADIAL`/`ANGULAR`/`DIAMOND`는 중앙 정렬 원형으로 근사 중이고,
`fillPaints`가 여러 겹이면 첫 번째만 쓴다. **두 샘플 다 발생 0건이라 검증 불가**.
해당 케이스가 있는 파일이 생기면 transform 반영해 타원 중심·반지름 계산, 다중 레이어는
`background` 다중 값으로 쌓을 것.

### constraints
`horizontalConstraint`/`verticalConstraint` 미반영. kyowon은 2617개 전부 `SCALE`(기본값)이라
반응형 의도 신호가 없다. `STRETCH`/`MIN`/`MAX`가 실제로 쓰인 파일에서 매핑할 것.

### 래핑 그리드
반복 항목의 행·열 수는 측정해서 `layout.repeat.columns/rows`로 넣지만,
`flex-wrap`/`grid` 레이아웃 모드 자체는 추론하지 않는다.
컨테이너에 구분선·연결선이 섞여 있어 "무엇이 콘텐츠인가"를 가릴 근거가 없다.

### 하드 사이징 vs hug — 시도했고 되돌림
`layout.hug` 축을 `fit-content`로 풀어봤으나 **렌더가 깨진다.**
Textarea Field 프레임에서 다중행 입력창이 100px → 48px로 붕괴했다.
Figma가 확정한 측정값이 콘텐츠 크기보다 큰 경우(최소 높이 등)를 CSS가 재현하지 못한다.

결론: 기준선 렌더러는 측정된 고정 크기를 유지한다. 그래서 `align-self`/`flex-grow`는
CSS에서 무효지만 IR에는 남아 있고, 반응형 마크업을 쓸 모델이 그걸 보고 판단하면 된다.
다시 시도한다면 hug 축에 `min-width`/`min-height`로 측정값을 깔고 크기를 푸는 방향.

### VARIABLE — 완료
`get_variables` 툴이 세트·모드·타입별 값을 전부 읽는다 (matsq 기준 14세트 581변수).
색은 `paint.colorVar` 바인딩으로 원본 토큰명(`--background-brand-default`)을 쓰고,
FLOAT는 px(단, weight/opacity/line-height는 무단위), 별칭은 `var(--원본)`으로 유지.
모드는 세트별로 `:root` + `[data-<set>="<mode>"]` 블록.

바인딩은 fill/stroke/아이콘 path 전부에서 읽는다 (matsq 127프레임 기준 색 1162개 중 808개가
원본 이름을 얻고, 그중 63개는 stroke·아이콘 경로로만 도달 가능하다).

**FLOAT 바인딩은 두 샘플에 존재하지 않는다.** 노드를 전수 조사했으나 `*Var` 필드는
`fillPaints.colorVar` / `strokePaints.colorVar` / `stopsVar`뿐이고, `stopsVar`는 리터럴 값만
담고 별칭이 없다. `radius`/`gap`이 변수에 묶인 파일이 생기면 그때 매핑할 것.

### 폰트 — 완료
프레임이 실제로 쓰는 패밀리·굵기로 Google Fonts 링크를 생성한다.
Pretendard만 jsdelivr로 예외 처리.

주의: css2 요청에 그 패밀리가 발행하지 않는 굵기만 들어가면 **요청 전체가 400**이 되어
폰트가 통째로 죽는다 (Lato에는 600이 없다). 그래서 항상 400을 포함시킨다.
두 샘플의 모든 프레임에서 생성된 URL 16개를 curl로 확인해 전부 200.

### 미처리 노드 타입
`STICKY` `WIDGET` `CONNECTOR` `SHAPE_WITH_TEXT` `STAMP` — matsq에 소량 존재.
주석/다이어그램용이라 마크업 대상이 아니므로 우선순위 낮음.

---

## 실사용에서 나온 갭 (ARCHIVE 프레임을 MCP만으로 구현해 본 결과)

### 텍스트와 배경 결합 — 완료
칠해진 사각형이 자기가 완전히 감싸는 뒤쪽 형제를 입양한다 (`nestByContainment`).
좌표는 새 부모 기준으로 재계산되므로 **절대 위치는 그대로**다 — 두 샘플 139개 프레임의
모든 노드 절대 좌표가 변경 전후 완전히 동일함을 대조해 확인했다.

핵심 제약: 입양은 페인트 순서를 앞으로 당기므로, **호스트와 자식 사이에 그려지는 형제가
자식과 겹치면 입양하지 않는다.** 이 조건 없이는 패널이 선반을 입양하면서 그 사이의
`Rectangle 14`가 위로 올라와 책을 덮는다(실제로 겪음).

칠해진 상자가 텍스트를 정확히 하나 품으면 `label`이 붙는다 (kyowon 113개, matsq 649개).
auto-layout으로 이미 중첩된 파일에서도 동일하게 동작한다.

### 인터랙티브 역할 어휘
`role`은 여전히 frame/text/image/icon/backdrop이다. `role: 'button'`은 넣지 않았다 —
"이건 버튼이다"를 검증할 정답이 없다. 대신 `label` + `style.fill/border` + 노드 이름이
사실만으로 같은 판단 근거를 준다. 오탐 없이 버튼을 가려낼 기준이 생기면 그때 추가할 것.

### repeat — 래퍼는 통과, 부모를 건너뛰는 건 미해결
서명을 계산할 때 자기 페인트가 없는 단일 자식 래퍼(마스크·그룹)를 통과한다.
matsq에서 7건/21항목이 추가로 잡혔고 전부 실제 동일 크기 셀이다.

**ARCHIVE 선반 3줄은 여전히 안 잡힌다.** 세 줄이 서로 다른 트리 레벨에 있기 때문이다 —
하나는 클립 래퍼 안, 하나는 패널에 입양됨, 하나는 겹침 규칙에 막혀 프레임 직속.
부모를 건너 반복을 세려면 추측이 필요하고, 여기서는 그 선을 넘지 않았다.
참고로 이 화면에서 진짜 반복 단위인 책 7권은 이미 정확히 잡힌다.

### 그라디언트 토큰 — 완료
`get_tokens`가 그라디언트도 `--gradient-N`으로 집계한다 (ARCHIVE 탭 2종 포함).
아이콘 내부 `<defs>`를 가리키는 `url(#…)`은 그 아이콘 밖에서 의미가 없으므로 제외한다.

### 행 그룹핑 — 표가 완전히 평평하다 (미해결, 가장 큼)
두 번째 dogfood(ARCHIVE 표 프레임)에서 나온 것. 표 본문의 교재명 11개·상태 11개·날짜 22개가
전부 같은 컨테이너의 평면 형제다. `<table>`을 쓰려면 모델이 직접 y로 묶고 x로 열을 맞춰야 한다.

게다가 **형제 순서는 z-order이지 읽는 순서가 아니다.** y값이 347, 437, 572, 707, 392…처럼
뒤섞여 있어서, DOM 순서대로 쓰면 행이 섞인다.

후보: 절대 배치 컨테이너의 자식을 y→x로 정렬한 `order` 힌트를 따로 싣고,
같은 y 밴드를 공유하는 자식들을 행으로 묶어 `layout.rows` 같은 형태로 내기.
페인트 순서를 바꾸면 안 되므로 순서 자체를 바꾸는 게 아니라 힌트로 실어야 한다.

## 검증 규약 (작업마다)

1. `pnpm test` 통과
2. `pnpm census`와 `pnpm census samples/matsq.fig` 둘 다 확인 —
   **"nodes that vanished" 행이 나오면 노드가 조용히 사라지고 있다는 뜻이다.** 0이어야 한다
3. **프레임 여러 개 렌더 후 스크린샷 육안 확인.** 한 프레임만 보고 끝내지 말 것 —
   지금까지 발견된 버그 중 다수가 Login 프레임에서는 멀쩡해 보였다
4. 수정 전후 출력 HTML을 diff 해서 의도 외 변경이 없음을 보인다
5. 새 로직마다 `assert` 검사 1개 (`src/*.test.mjs` 스타일, 프레임워크 없음)

렌더: chrome-devtools MCP `new_page(file:///…/index.html)` → `resize_page(1440,960)` → `take_screenshot`

---

## 하지 말 것

- `get_html`을 프로덕션 마크업으로 만들기. 기하 기준선·대조용이다
- 샘플 없이 기능 추가. 검증 못 하는 렌더링 코드는 넣지 않는다
- 벡터 네트워크 blob 파서. 실패하는 blob은 `fillGeometry`/`strokeGeometry`의 중복 표현.
  census에서 "이 blob만 참조하고 다른 지오메트리 없는 노드"가 나오면 그때 재검토
- OpenPencil/Figma MCP 재도입. 그 한계가 이 프로젝트의 존재 이유다
