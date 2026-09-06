# fig-parser — 남은 작업 goal prompt

에이전트에게 그대로 넘기는 작업 지시서. `claude` 세션에서 `@TASKS.md` 로 참조하거나 통째로 붙여넣어 사용.

---

## 컨텍스트

`.fig` 파일(ZIP + `canvas.fig`)을 파싱해 코드 지향 IR로 바꾸고, MCP로 노출하는 프로젝트.
목적은 **AI가 디자인을 보고 정확한 마크업을 작성하게 하는 것**. 픽셀 완벽한 뷰어가 아니라, 모델이 읽고 재현할 수 있는 표현이 목표.

```
src/parse.mjs   fig-kiwi 컨테이너 해제, 트리 복원, path blob 디코드
src/ir.mjs      노드 -> IR 정규화 (아이콘 병합, 레이아웃 추론, 페인트 변환)
src/html.mjs    IR -> HTML/CSS 기준선 렌더러
src/cli.mjs     node src/cli.mjs <file.fig> [frame] [outDir]
src/mcp.mjs     MCP 서버 (list_frames / get_frame / get_html / export_assets / get_tokens)
```

```bash
pnpm test                                                   # 전체 검증
node src/cli.mjs samples/kyowon-full.fig                    # 프레임 목록
node src/cli.mjs samples/kyowon-full.fig "온라인학습_Login" out/login
```

샘플: `samples/kyowon-full.fig` (gitignore 처리됨, 4050 노드, 12 프레임).
없으면 테스트는 skip 처리되므로 **반드시 샘플을 확보하고 시작할 것.**

---

## 절대 되돌리지 말 것

이미 비싸게 알아낸 사실들. 리팩터링 중 무심코 깨기 쉬우니 손대기 전에 읽을 것.
셋 다 테스트로 고정돼 있다. 테스트가 빨간불이면 원인은 거의 항상 아래 셋 중 하나다.

1. **형제 정렬은 바이트 비교.** `parentIndex.position`은 문장부호로 만들어진 fractional index다.
   `localeCompare`는 이걸 로케일 규칙으로 재배치해 z-order를 무너뜨린다.
   증상: 배경 패널이 콘텐츠 위에 그려져 화면 전체를 덮음.

2. **path 좌표는 스케일하지 않는다.** 이미 노드의 `size` 공간에 있다.
   `vectorData.normalizedSize`는 원본 아트보드 크기이지 좌표계가 아니다.
   증상: 아이콘이 좌상단 서브픽셀 점으로 수축 (실측 배율 0.038×).

3. **stroke는 이미 아웃라인이다.** `strokeGeometry`는 채울 수 있는 영역이며,
   `fillGeometry`와 동일하게 칠하되 paint만 `strokePaints`를 쓴다. CSS `stroke`로 바꾸지 말 것.

---

## Task 0 — 미처리 기능 조사 (먼저 할 것)

나머지 작업의 우선순위를 감이 아니라 데이터로 정하기 위한 단계.

`src/census.mjs`를 만들어, 12개 프레임 전체 노드를 순회하며 **우리가 버리고 있는 것**을 집계한다:

- 처리하지 않는 노드 타입 (`SYMBOL`, `INSTANCE`, `SECTION`, `STAMP`, ...)
- `fillPaints`/`strokePaints` 중 CSS로 변환 못 한 paint 타입, 각 발생 횟수
- `effects` 중 `DROP_SHADOW` 외 타입
- 단위행렬이 아닌 `transform` (회전/스케일/반전) 개수
- 디코드 실패한 blob 개수와 그 blob을 참조하는 노드 타입
- `textData.styleOverrideTable`이 비어있지 않은 TEXT 노드 (혼합 서식)
- 최종 IR에 도달하지 못하고 사라진 노드 수 (입력 노드 수 대비 IR 노드 수 + 병합된 아이콘 수)

출력은 표 하나. `pnpm census`로 실행 가능하게 할 것.

**완료 기준:** 표가 나오고, 각 행이 아래 Task 중 하나에 대응되거나 "의도적으로 무시" 목록에 명시된다.
이 표가 이후 작업의 진척 지표다 — 작업마다 해당 행이 0으로 내려가야 한다.

---

## Task 1 — 회전 / 스케일 / 반전 transform

현재 `transform`에서 `m02`/`m12`(위치)만 읽고 `m00/m01/m10/m11`은 버린다.
회전된 배지, 반전된 화살표, 스케일된 그룹이 전부 정위치로 그려진다.

- IR `box`에 `transform` 필드 추가 (단위행렬이면 생략)
- 렌더러는 CSS `transform: matrix(m00, m10, m01, m11, 0, 0)` + `transform-origin: 0 0`
- 아이콘 클러스터 내부에서는 SVG `transform="matrix(...)"`로, 현재의 `translate(...)`를 대체
- `size`는 변환 전 크기임에 주의 — 레이아웃 추론에 쓰는 bbox는 변환 후 값이어야 한다

**완료 기준:** census의 비단위행렬 카운트가 0. 회전 요소가 있는 프레임 렌더 스크린샷에서 각도가 눈으로 맞음.
단위행렬 노드의 출력 CSS는 이전과 **바이트 단위로 동일**해야 한다 (회귀 없음 증명).

---

## Task 2 — SYMBOL / INSTANCE 오버라이드

**샘플이 없다.** 검증 불가능한 코드를 쓰지 말 것.

1. 먼저 컴포넌트/인스턴스가 포함된 `.fig`를 확보한다. 사용자에게 요청하거나,
   Figma에서 컴포넌트 2~3개와 그 인스턴스(텍스트·색상 오버라이드 포함)만 있는 파일을 만들어 export.
   확보 전에는 이 작업을 시작하지 말고 사용자에게 물을 것.
2. `SYMBOL` 노드를 마스터로 등록하고, `INSTANCE`는 마스터 서브트리를 복제한 뒤
   오버라이드(`symbolData`의 overrides)를 적용해 해석한다.
3. IR에 `component: { name, instanceOf }`를 남긴다 — 모델이 반복 요소를 컴포넌트로 인식하게 하는 게 핵심 가치다.

**완료 기준:** 인스턴스 3개가 마스터와 다른 텍스트/색으로 렌더된다. 마스터 수정이 인스턴스에 반영된다.
샘플 파일을 `samples/`에 두고 테스트를 붙인다.

---

## Task 3 — paint 커버리지 완성

현재 SOLID / GRADIENT_LINEAR / IMAGE만 처리. 나머지는 조용히 사라진다.

- **그라디언트 stroke**: `strokeColor()`가 SOLID만 찾는다. `fillOf()`와 동일한 경로를 타게 통합
- **GRADIENT_RADIAL/ANGULAR/DIAMOND**: 지금은 중앙 정렬 원형으로 근사. transform을 반영해
  타원 반지름과 중심을 실제 값으로 계산
- **이미지 `scaleMode`**: 항상 `cover`로 렌더 중. `FILL`/`FIT`/`TILE`/`STRETCH`를
  각각 `cover`/`contain`/`repeat`/`100% 100%`로 매핑
- **여러 겹의 fill**: 지금은 첫 번째만 쓴다. 다중 레이어는 CSS `background` 다중 값으로 쌓기

**완료 기준:** census의 미변환 paint 카운트 0. 이미지 fill 노드 중 잘림/늘어남이 원본과 다른 것 없음.

---

## Task 4 — 텍스트 충실도

- **혼합 서식**: `textData.styleOverrideTable` + 문자 범위를 무시하고 있어,
  한 텍스트 노드 안의 굵은 단어/다른 색 구간이 전부 소실된다. `<span>` 분할로 처리
- `textAlignVertical` (`CENTER`/`BOTTOM`) → flex 정렬
- `textAutoResize` — 고정 폭인지 내용 맞춤인지에 따라 `width` 지정 여부가 달라진다
- `textCase` (`UPPER`/`LOWER`/`TITLE`) → `text-transform`
- `textDecoration` → `text-decoration`
- 폰트 폴백: 지금 `"Pretendard", sans-serif` 고정. 실제 `fontName.family`별로 스택 생성

**완료 기준:** 혼합 서식 텍스트 노드가 census에서 잡히면 그 개수만큼 `<span>`이 생성된다.
텍스트만 있는 프레임의 렌더가 원본과 줄바꿈 위치까지 일치.

---

## Task 5 — 마스크와 블렌드

`온라인학습_LEARNING QUEST`의 `mask` 노드(1469×968, 검정 30%)를 지금은 그냥 반투명 오버레이로 그린다.
Figma에서 마스크는 형제들을 **클리핑**한다 — 의미가 완전히 다르다.

- 마스크 노드 감지 후 CSS `mask-image` 또는 SVG `<clipPath>`로 변환
- `blendMode`가 `NORMAL`/`PASS_THROUGH`가 아닌 노드 → CSS `mix-blend-mode`
- `INNER_SHADOW` → `box-shadow inset`, `FOREGROUND_BLUR` → `filter: blur()`,
  `BACKGROUND_BLUR` → `backdrop-filter: blur()`

**완료 기준:** 마스크가 있는 프레임에서 클리핑이 실제로 일어난다. census의 미처리 effect 0.

---

## Task 6 — 레이아웃 추론 실전 검증

**남은 것: auto-layout 샘플 확보.** `stackMode` 경로가 여전히 미검증이다 —
이 파일에는 auto-layout 프레임이 하나도 없다. 샘플을 받으면 검증할 것.

완료된 것:
- 반복 구조 감지 — 같은 형태(role·크기·자식 구성)의 형제 3개 이상이면
  `layout.repeat = { count, like }`. 이 파일에서 31곳 검출, 테스트로 고정
- 기하 추론은 회전된 자식의 `bounds`를 쓰도록 수정됨 (Task 1)

**의도적으로 보류:** `horizontalConstraint`/`verticalConstraint`.
이 파일은 2617개 노드 전부 `SCALE`(Figma 기본값)이라 반응형 의도 신호가 없다.
STRETCH/MIN/MAX가 실제로 쓰인 샘플이 생기면 그때 매핑할 것.

래핑 그리드(`flex-wrap`/`grid`) 인식도 아직 없다.

---

## Task 7 — 대형 프레임 대응

`온라인학습_My Page`의 IR이 551KB다. `get_frame` 한 번에 컨텍스트가 무너진다.

- `get_frame`에 `select` 인자 추가 — 이름/역할로 서브트리만 뽑기
- 요약 모드: 노드가 N개를 넘으면 자동으로 얕은 트리 + "깊이 파려면 이 id로 다시 호출" 안내
- `get_tokens` 토큰 이름이 `--color-1`이다. 사용처 기반 의미 이름으로 개선
  (텍스트 전용 색 → `--text-muted`, 최다 사용 배경 → `--surface` 등)

**완료 기준:** 어떤 프레임이든 `get_frame` 기본 호출이 30KB 이하.
큰 프레임에서도 모델이 추가 호출만으로 필요한 서브트리에 도달 가능.

---

## 검증 규약

작업마다 반드시:

1. `pnpm test` 통과
2. `pnpm census` 로 해당 카운트가 내려갔는지 확인
3. **12개 프레임 전부 렌더 후 스크린샷 육안 확인.** 한 프레임만 보고 끝내지 말 것 —
   지금까지 발견된 버그 셋 중 둘은 Login 프레임에서 멀쩡해 보였다
4. 회귀 확인: 수정 전후 출력 HTML을 diff 해서, 의도한 변경 외에 달라진 게 없음을 보인다
5. 새 로직에는 실행 가능한 검사를 하나 남긴다. 프레임워크 없이 `assert` 기반으로,
   기존 `src/*.test.mjs` 스타일을 따를 것

렌더 확인은 chrome-devtools MCP 사용:
```
new_page(file:///…/out/<frame>/index.html) -> resize_page(1440, 960) -> take_screenshot
```

---

## 하지 말 것

- `get_html` 출력을 실제 프로덕션 마크업으로 만들려는 시도.
  이건 기하학적 기준선이고, 대조용이다. 의미론적 마크업은 모델이 IR을 보고 쓴다
- 검증할 샘플 없이 기능 추가 (Task 2가 대표 사례)
- 벡터 네트워크 blob 파서 작성. `fillGeometry`/`strokeGeometry`로 충분하며,
  실패하는 641개 blob은 이미 처리된 경로의 중복 표현이다.
  census에서 "이 blob만 참조하고 다른 지오메트리가 없는 노드"가 나오면 그때 재검토
- OpenPencil / Figma MCP 재도입. 이 프로젝트가 존재하는 이유가 그것들의 한계다
