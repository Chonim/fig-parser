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

남은 것: 변수 바인딩이 **색에만** 붙어 있다. `radius`/`gap`/`padding`처럼 FLOAT 변수가
바인딩된 속성은 IR에서 여전히 리터럴 값으로 나온다. 노드 쪽 바인딩 필드를 찾아
`style.radius`를 `var(--radius-md)`로 낼 수 있으면 마크업 품질이 한 단계 오른다.

### 미처리 노드 타입
`STICKY` `WIDGET` `CONNECTOR` `SHAPE_WITH_TEXT` `STAMP` — matsq에 소량 존재.
주석/다이어그램용이라 마크업 대상이 아니므로 우선순위 낮음.

---

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
