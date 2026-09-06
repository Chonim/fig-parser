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

### 텍스트와 배경이 서로 남남
`복습` 텍스트(115,191)와 그 탭 배경 `Rectangle 2`(62,175)는 부모-자식이 아니라 형제다.
버튼·탭·입력창 전부 같은 구조라, 모델이 "이 글자가 저 상자의 라벨"임을 알려면 기하학적
포함 관계를 직접 계산해야 한다. IR이 해줄 수 있는 일이고, 시맨틱 마크업 품질에 가장 크게
영향을 준다. 후보: 텍스트가 형제 사각형 안에 완전히 들어가고 그 사각형에 다른 텍스트가
없으면 하나의 노드로 접기.

### 인터랙티브 역할 어휘가 없음
`role`은 frame/text/image/icon/backdrop뿐이다. 버튼도 탭도 카드도 전부 `frame`.
이름에 `btn`이 들어있어도 IR은 아무 것도 하지 않는다. 위 항목과 합치면
`role: 'button'` 수준의 힌트를 낼 근거가 생긴다.

### repeat 임계값이 실제 반복을 놓침
선반이 3줄인데 `layout.repeat`가 안 붙었다. 같은 서명의 형제가 2개뿐이고
세 번째는 `Mask group` 안에 들어가 있어서다. 같은 서명이 부모를 건너 반복될 때를
어떻게 셀지 재고할 것.

### 그라디언트는 토큰이 되지 않음
`get_tokens`는 `#rrggbb`/`rgba`만 집계한다. 이 프레임의 탭 두 개는 그라디언트 배경이고,
디자인상 명백히 재사용되는 값인데 토큰 목록에 없다.

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
