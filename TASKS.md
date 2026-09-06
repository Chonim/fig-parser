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

---

# 감사 결과 작업 계획

병렬 감사 6건(IR 정확성 / MCP 계약 / 렌더러 CSS / 테스트 엄밀성 / 포맷 커버리지 / 3차 dogfood)에서
나온 것. 모든 수치는 두 샘플 실측이다. **Phase 0을 건너뛰지 말 것** — 감사가 증명했듯
현재 스위트는 깨진 코드에서도 초록이라, 이후 수정을 검증할 수단이 없다.

---

## Phase 0 — 검증 체계 먼저 (다른 것보다 앞)

뮤테이션 테스트로 확인된 사실: 불변식 6개 중 **3개가 무방비**, 공허한 단언 3개.

1. **path 스케일 금지(불변식 2)가 무방비.** `parse.test.mjs`의 아이콘 검사가 path 좌표가 아니라
   **translate 오프셋을 재고 있다.** 스케일 버그를 되돌려도 좌표가 60.084 → 0.943으로 붕괴하는데 초록.
   → transform을 제외한 순수 path 좌표의 최대 절대값을 `box.w/h`와 비교할 것.
2. **SECTION 순회(불변식 6)가 무방비.** `components.test.mjs`가 순회를 자기가 다시 구현해
   자기 사본과 대조한다. 프로덕션 코드는 호출조차 안 된다.
   → 프레임 수집기를 `mcp.mjs`에서 export 하고 테스트가 **그것을** 부를 것.
3. **공허한 단언 제거.**
   - `renderHTML(a) === renderHTML(a)` — 양변이 같은 입력의 같은 함수. `rows`가 있으면
     자식을 뒤집도록 만들어도 통과한다. → `rows`를 제거한 IR과 비교하는 대조군으로 바꿀 것.
   - `parts[0].cmd === 'M'` / `every(p => 'MLQCZ'.includes(p.cmd))` — `PATH_LETTER`가 정확히
     그 집합이라 실패 불가. `PATH_LETTER`를 전부 `'M'`으로 만들어도 통과. → 알려진 blob의
     기대 `d` 문자열, 또는 `parts.some(cmd === 'C')`.
   - `absolute()` 헬퍼가 절대 좌표를 모으지만 **전후 비교를 안 한다.** 재계산에 3px 오차를
     넣어도 통과. → 원래 용도대로 nesting 전후 좌표 집합을 비교할 것.
4. **census 잔액이 한쪽만 본다.** `if (lost > 0)` 때문에 matsq의 실제 부호 있는 잔액 **−18**이
   숨는다(+48/−66 상쇄). → 절대값으로 보고하고, 프레임별로 쪼개서 어디서 어긋나는지 낼 것.
   census 자체에 테스트가 없다 — `raw = IR + collapsed + folded + invisible`을 단언할 것.
5. **샘플 없으면 `exit 0`.** CI에서 새 클론과 통과가 구분되지 않는다.
   → `CI` 환경변수가 있으면 skip을 실패로, 또는 어떤 스위트도 `ok —`를 찍지 않으면 실패.
6. MCP 진입점 커버리지 부재: `mcp.mjs`가 `symbolIndex`에 잘못된 것을 넘기거나 `variables`를
   통째로 빠뜨려도 초록이다. matsq 케이스를 `mcp.test.mjs`에 추가할 것.

**완료 기준:** 위 6개 불변식을 하나씩 고의로 깨뜨렸을 때 전부 빨간불. 그 확인을 실제로 수행할 것.

---

## Phase 1 — 지금 잘못 렌더되는 것

**1-1. `layout.rows` 인덱스가 다른 배열을 가리킨다. (최우선)**
두 호출자가 서로 다른 배열을 넘긴다 — `inferLayout:579`는 backdrop을 걸러낸 `flow`,
`nestByContainment:455`는 안 거른 `host.children`. `rowBands`의 인덱스 맵은 인자 기준이다.
kyowon 29개 중 **12개가 전부 엉뚱한 노드를 지목**하고, `온라인학습_LEARNING QUEST`는
자식 22개인데 인덱스가 19를 안 넘어 2개는 도달 불가.
→ 인덱스를 항상 노드의 `children` 기준으로 통일하고, 두 호출자 모두에 대해 테스트할 것.

**1-2. 숨긴 인스턴스가 렌더된다.**
`expandInstance`(ir.mjs:717)가 `{...apply(master), guid, id, name, transform, size}`를 반환하며
**`visible`을 싣지 않는다.** `visible === false` 검사는 INSTANCE 분기 뒤에 있다.
matsq 98개 중 **66개가 IR에 살아남는다** — `Checkbox Field`가 해제 상태 위에 체크를 그린다.
같은 줄에서 인스턴스 자신의 `stackPositioning`/`stackChildAlignSelf`/`stackChildPrimaryGrow`도
잃는다(32개가 마스터와 다름).

**1-3. 추론 flex가 자식의 교차축 오프셋을 버린다.**
`inferLayout:563-577`이 `padding`에 `Math.min(...starts)`만 쓰고 `align`은 `flex-start`.
`html.mjs:47`은 부모가 absolute일 때만 자식을 절대배치하므로, 교차축 시작점이 다른 자식은
어긋나 렌더된다. kyowon **84개 중 55개**. 최악 `Frame 76#2313:2264`는 **248px**.
→ 교차축 오프셋이 균일하지 않으면 flex로 부르지 말거나, 자식별 오프셋을 실을 것.

**1-4. `rowBands` 밴드가 연쇄 증식한다.**
`ir.mjs:385-388`의 가드는 큰 항목이 페이지를 삼키는 걸 막으려던 것인데, 일단 한 항목이
`bottom`을 늘리면 `Math.min`이 `k.box.h`를 골라 **그 안에 들어오는 이후 항목이 전부 합류**한다.
`온라인학습_LEARNING QUEST`에서 6단 세로 목록이 **9개짜리 한 행**(773.9px)으로, 다른 곳에서는
4×5 격자가 **20개 한 행**으로 뭉친다. → 밴드 범위를 첫 항목으로 고정하거나 중앙값 기준으로.

**1-5. 클래스명 충돌.** `className()`이 접미사 없는 이름만 `seen`에 등록해서, 10번째 `Vector`가
만든 `vector-10`을 실제 `Vector 10` 레이어가 가로챈다. `My Room`에서 `.vector-10` 두 개가
computed style이 동일 — 화살표는 21.56²로 부풀고 돋보기는 180° 뒤집힌다. kyowon 5건.
→ 생성된 이름도 `seen`에 등록할 것. 비라틴 이름이 빈 문자열로 슬러그되는 것도 같이(충돌 유발).

**1-6. 루트 폭이 안 지켜진다.** `body{display:flex}`로 루트가 flex item이 되어 `flex-shrink:1`.
1440 선언이 600 뷰포트에서 600으로 줄고 절대배치 자식은 `left/top`을 유지해 찢어진다.
**1440 창 + 스크롤바면 이미 발동.** → 루트에 `flex-shrink:0`.

**1-7. 아이콘 viewBox가 stroke 아웃라인을 잘라낸다.** `viewBox="0 0 box.w box.h"`인데 `<svg>`는
기본 `overflow:hidden`. **43개가 `height:0`으로 아무것도 안 그린다**(표의 행 구분선 전부).
1040개 중 437개가 0.25px 이상 잘린다. → 실제 path 범위로 viewBox를 잡을 것.

**1-8. 숨긴 프레임이 모든 툴을 크래시.** `toIR`이 null을 반환하는데 `framesOf`/`cli.mjs`/`renderHTML`이
역참조한다. matsq 8개 프레임.

---

## Phase 2 — 도구 계약

**2-1. `get_frame`이 텍스트를 버리면서 버렸다는 표시를 안 한다.** 잘린 텍스트 노드가 `text` 없이
완결된 리프처럼 보인다. kyowon 35/211, matsq **460/1616**만 보인다. 마크업을 쓰라는 도구가
글자를 안 준다. → 예산과 무관하게 `text.content`를 유지(먼저 버릴 것은 `family`/`letterSpacing`),
`stub`에도 `text`와 `asset.kind`를 실을 것.

**2-2. 인스턴스 안쪽에 토큰이 없다.** `ir.mjs:724`가 `{isRoot, symbols, instanceOf}`만 넘기고
`variables`를 빠뜨린다. matsq에서 인스턴스 내부 1289개 노드 전부 토큰 0, 외부는 49%.
한 줄 고치면 **+328개** 복구.

**2-3. `get_tokens.css` 폰트에 폴백이 없다.** `--font: 600 12px/14px "Lato"` — 그대로 쓰면
**페이지 전체가 Times**. CLI 렌더러는 `"Lato", sans-serif`를 낸다. 같은 도구가 두 답을 준다.

**2-4. `get_tokens`가 rgba를 콤마로 쪼갠다.** `--border-transparency: 0.2);`가 나온다.

**2-5. 인스턴스가 마스터 노드 id를 재사용한다.** matsq 프레임 16개에 중복 id, 한 프레임에 23개.
`selectNode`가 첫 매치를 조용히 고르므로 `select`가 엉뚱한 노드를 준다.
→ 확장 시 id에 인스턴스 접두사를 붙일 것.

**2-6. variant를 `repeat`으로 보고한다.** 한 컴포넌트의 3개 상태를 3열 그리드로 오독하게 만든다.
`variantPropSpecs`(269개)를 읽어 `component.variant`로 실을 것.

**2-7. 나머지 계약 문제.** 심볼릭 링크로 `FIG_ROOT` 우회 가능(읽기·쓰기 모두, `realpath` 미사용) /
`load()` 캐시 무효화 없음 / `fit()`이 균일 depth라 깊은 가지 하나가 전체를 굶김(33개 중 12개가
예산 50% 미만) / 이름 없는 프레임 19개가 주소 불가(에러가 이름만 나열) / `get_variables` 159KB에
예산 없음 / `export_assets`의 `usedBy`가 틀린 id를 준다 / `label`이 README에 없고 일관성 없다.

---

## Phase 3 — 없다고 믿었지만 데이터에 있는 것

**여기 적힌 "없다"는 내가 불완전한 스캔으로 단언했던 것이고, 감사가 반증했다.**

- **`variableConsumptionMap` — matsq 1951개 노드.** STACK_SPACING 659, 코너 반경 434×4,
  패딩 ~400, 보더 두께 110×4, FONT_SIZE 86, LINE_HEIGHT 4. 전부 로컬 `VARIABLE` 이름으로 해석된다.
  `effects[].radiusVar/xVar/yVar` 11개도. → `radius: var(--radius-md)`가 지금 가능하다.
  **이 프로젝트의 목적에 가장 가까운 항목.**
- **`prototypeInteractions` 194개(`ON_CLICK` 등).** `role:'button'`을 검증할 정답이 없다고 적었는데,
  이것이 그 정답이다.
- **`frameMaskDisabled`** — matsq 989개 클립 컨테이너 중 **113개가 실제로 자식이 넘치고**,
  kyowon은 534개 중 64개. 지금은 마스크 자식이 있을 때만 `clip`을 낸다.
- **constraints** — matsq에 h:CENTER 47, STRETCH 12, MAX 15, v:CENTER 620.
- 독립 보더 두께(한 변만 0인 것 8개가 네모로 그려진다), `maxLines`+`textTruncation` 32개,
  `strokeAlign`(OUTSIDE는 칠이 `2×width` 줄어든다), `dashPattern` 29개.

---

## Phase 4 — 문서 정정

- CLAUDE.md의 "constraints는 두 샘플에 없다"는 거짓 — matsq에 있다.
- TASKS.md의 "FLOAT 바인딩은 두 샘플에 존재하지 않는다"는 거짓 — 1951개 노드에 있다.
- "두 샘플 모두 census 균형"은 kyowon에만 해당.
- 새 불변식 후보: **인스턴스 확장은 인스턴스 자신의 `visible`·flex-child 속성을 유지해야 한다**,
  **인덱스를 내보내는 힌트는 어느 배열 기준인지 한 곳에서만 정한다**.

---

## 검증 규약 (작업마다)

1. `pnpm test` 통과 — 단, **Phase 0을 끝내기 전의 초록은 신뢰하지 말 것**
2. `pnpm census`와 `pnpm census samples/matsq.fig` 둘 다. 잔액은 절대값으로 0이어야 한다
3. 두 샘플의 프레임을 **여러 개** 렌더하고 스크린샷 육안 확인. 한 프레임만 보고 끝내지 말 것 —
   지금까지 나온 버그 대부분이 처음 본 프레임에서는 멀쩡해 보였다
4. IR 구조를 바꾸는 변경은 **절대 좌표 집합 대조**로 검증할 것. nesting·rows 작업에서 쓴 방법이다:
   모든 프레임의 모든 노드에 대해 부모 오프셋을 누적한 좌표를 정렬해 변경 전후 diff → 완전 일치
5. 새 로직마다 `assert` 검사 1개. **그 검사가 실제로 실패하는지 고의 파손으로 확인할 것** —
   이번 감사에서 공허한 단언 3개가 그 확인을 안 해서 통과하고 있었다

렌더: chrome-devtools MCP `new_page(file:///…/index.html)` → `resize_page(1440,960)` → `take_screenshot`

## 하지 말 것

- `get_html`을 프로덕션 마크업으로 만들기. 기하 기준선·대조용이다
- 샘플 없이 기능 추가. 검증 못 하는 렌더링 코드는 넣지 않는다
- 벡터 네트워크 blob 파서. 실패하는 blob은 `fillGeometry`/`strokeGeometry`의 중복 표현.
  census에서 "이 blob만 참조하고 다른 지오메트리 없는 노드"가 나오면 그때 재검토
- OpenPencil/Figma MCP 재도입. 그 한계가 이 프로젝트의 존재 이유다
