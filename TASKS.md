# fig-parser — 남은 작업

`.fig`(ZIP+`canvas.fig`) → 코드 지향 IR → MCP 노출.
목적은 **AI가 디자인을 읽고 정확한 마크업을 쓰게 하는 것**. 픽셀 완벽 뷰어가 아니다.

```
src/parse.mjs     컨테이너 해제, 트리 복원, path blob 디코드
src/ir.mjs        노드 -> IR (아이콘 병합, 인스턴스 확장, 레이아웃 추론, 페인트)
src/html.mjs      IR -> HTML/CSS 기준선 렌더러
src/cli.mjs       node src/cli.mjs <fig> [frame] [outDir]
src/mcp.mjs       MCP 서버 (list_frames / get_frame / get_html / export_assets / get_tokens / get_variables)
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

# 남은 것

병렬 감사 6건에서 나온 계획(Phase 0~4)은 전부 완료했다. 수치는 두 샘플 실측이며
`pnpm census`, `pnpm census samples/matsq.fig` 출력과 일치한다.
(raw = 프레임 아래에서 실제로 도달하는 노드. 위의 4050 / 7219는 마스터·페이지·변수까지 포함한 `nodeChanges` 전체다.)

```
kyowon-full  12 프레임  4013 raw = 1353 IR + 2647 아이콘 병합 + 2 마스크 + 11 비표시
matsq        97 프레임  5737 raw = 4442 IR +  678 아이콘 병합 + 0 마스크 + 617 비표시
```

census에 남은 행은 둘 다 의도적이다: 벡터 네트워크 blob(참조 0건 확인), 비표시 노드,
그리고 matsq의 외부 라이브러리 변수 바인딩 280건.

## 샘플에 없어서 안 만든 것

**이 목록에 손대기 전에 해당 케이스가 든 `.fig`부터 확보할 것.**
검증할 수 없는 렌더링 코드는 정직한 공백보다 나쁘다.

- **radial/angular/diamond 그라디언트** — 중앙 정렬 원형으로 근사 중. 두 샘플 발생 0건
- **다중 fill** — 첫 번째만 사용. 두 샘플에서 `fillPaints`가 2개 이상인 노드 0개
- **래핑 그리드** — 반복 항목의 행·열 수는 `layout.repeat`에 싣지만
  `flex-wrap`/`grid` 모드 자체는 추론하지 않는다. 컨테이너에 구분선·연결선이 섞여 있어
  "무엇이 콘텐츠인가"를 가릴 근거가 없다
- **추론 flex의 교차축 가드** — 순서 가드가 먼저 걸러서 두 샘플에서 아무것도 배제하지 않는다.
  추론을 보수적으로만 만들기에 남겨두었으나 미검증이다

## 검증할 수 있지만 일부러 하지 않은 것

- **constraints를 CSS로** — IR에 사실로 싣는다(matsq 노드 164개, CENTER 271축 / MAX 18축).
  CSS로 바꾸면 위치가 움직이는데, 그 결과가 맞는지 확인할 방법이 이 파일들에는 없다
- **`layout.hug`으로 크기 풀기** — 시도했다가 되돌렸다. `fit-content`로 풀면
  Textarea Field의 다중행 입력창이 100px → 48px로 붕괴한다. Figma가 확정한 크기가
  콘텐츠 크기보다 큰 경우를 CSS가 재현하지 못한다.
  다시 시도한다면 hug 축에 `min-width`/`min-height`로 측정값을 깔고 크기를 푸는 방향
- **`role: 'button'`** — 근거는 이제 있다(matsq에 ON_CLICK 103건, `label` 607건).
  그래도 "이건 버튼이다"라고 단정하지 않고 사실만 싣는다. 어떤 요소를 쓸지는 읽는 쪽의 판단이다

## 알려진 잔여 결함

- **정답지가 없다** — Figma가 실제로 그리는 화면과 대조할 이미지가 없어서, 판정은 불변식과
  자동 검사와 육안뿐이다. 픽셀 단위로 "전수"를 주장하려면 프레임별 PNG 내보내기가 필요하다
- **`get_frame` 텍스트 도달률** — 한 번 호출로 kyowon 86/211, matsq 871/1616.
  예산이 30KB인 한 큰 프레임은 전부 담을 수 없고, 나머지는 `select`로 도달 가능하다.
  matsq 3개 프레임은 여전히 예산의 절반 미만만 쓴다(너비 우선 배분이 넓은 부모에서 보수적)
- **`FONT_STYLE` 변수 바인딩** — matsq의 139건 전부가 외부 라이브러리를 가리켜 해석 불가
- **`STICKY` `WIDGET` `CONNECTOR` `SHAPE_WITH_TEXT` `STAMP`** — matsq에 소량.
  주석·다이어그램용이라 마크업 대상이 아니다
- **`strokeAlign: CENTER`** — CSS에 반쪽 걸친 테두리가 없어 INSIDE로 근사.
  두 샘플 통틀어 CSS 테두리가 되는 노드는 1개뿐이라 코드를 넣을 근거가 없다
- **회전 노드의 flow 배치** — 흐름이 놓은 노드는 중심을 축으로 돌린다. 180°는 발자국이
  같아 정확하지만, 임의 각도는 Figma가 잡은 발자국과 어긋난다. 두 샘플의 임의 각도는
  `rotate(0.91deg)` 하나뿐이라 그 차이를 볼 수 있는 케이스가 없다

## matsq가 실제로 쓰는 기능 (전수)

97프레임 전부 렌더해 브라우저에서 자동 검사한 뒤 정리한 것.

```
paint        SOLID 4390  IMAGE 43  (그라디언트 0)
effect       DROP_SHADOW 119  INNER_SHADOW 3
blend        MULTIPLY 9
imageScale   FILL 29  STRETCH 7  FIT 3  TILE 4
strokeAlign  INSIDE 4144  OUTSIDE 1673  CENTER 788
autoResize   WIDTH_AND_HEIGHT 1369  HEIGHT 353
truncation   ENDING 32 (전부 maxLines 1이라 line-clamp 경로)
constraint   SCALE 730  CENTER 676  MAX 15  STRETCH 13
stack        HORIZONTAL 1138  VERTICAL 525   stackWrap 0
sizing       hug(counter) 1173  fixed(primary) 623
interactions SWAP_STATE 258  OVERLAY 10   (화면 이동 링크 0)
다중 fill 0  다중 stroke 0  mask 0
```

TILE은 `background-repeat: repeat`로, truncation은 line-clamp로 이미 처리됨.
인터랙션은 전부 컴포넌트 variant 교체나 컴포넌트 마스터를 가리켜 페이지 이동이 아니다 —
디자인 시스템이라 플로우가 없다.

### 디자인이 안 맞는 곳 (`layout.overflow`)

디자이너가 고정 크기 인스턴스를 내용보다 좁게 눌러놓은 자리. Figma도 자식을 줄이지
않고 클립도 안 해서 밖으로 흘러넘치고, 뒤에 그려지는 형제가 덮는다. matsq 1337개
auto-layout 상자 중 **26개**, kyowon은 auto-layout 자체가 없어 0.

가장 큰 것: GnbWrap의 Button이 마스터 124px인데 74px (라벨+화살표가 50px 넘침),
Frame 85/86이 세로로 2632 필요한데 2457.

이건 이 레이어의 결함이 아니라 원본의 상태다. 그대로 재현하되 IR이 사실로 싣는다 —
이 폭을 그냥 베끼면 마크업에서도 같은 자리에서 깨진다.

### 브라우저 자동 검사 결과 (109프레임)

깨진 이미지 0 · 텍스트 박스 넘침 0 · 프레임 밖 요소 0 ·
클립에 잘리는 요소는 kyowon 9건뿐이고 전부 진짜 마스크(의도된 크롭).
0 크기 요소 1건은 폭 0으로 저작된 spacer.

검사 항목은 지금까지 실제로 나온 실패 유형을 코드로 옮긴 것이다. **짜 넣지 않은 유형은
여전히 안 잡힌다** — 3px 링 잘림이 스크린샷 12장을 그냥 통과했던 것처럼.

## kyowon-full이 실제로 쓰는 기능 (전수)

12프레임 육안 스윕 때 같이 조사한 것. 이 파일에 관한 한 아래가 전부다.

```
paint        SOLID 3502  GRADIENT_LINEAR 64  IMAGE 158
effect       DROP_SHADOW 105  INNER_SHADOW 1
blend        DARKEN 6  HARD_LIGHT 1
imageScale   FILL 141  STRETCH 17
strokeAlign  INSIDE 3487  OUTSIDE 427  CENTER 136 (CSS 테두리가 되는 건 1개)
textResize   WIDTH_AND_HEIGHT 94  HEIGHT 40
constraint   SCALE 5234 (전부 기본값)
mask         ALPHA 2
다중 fill 0   다중 stroke 0   truncation 0
```

radial 그라디언트도, 다중 fill도, TILE도 이 파일엔 없다 — 위 목록이 그 근거다.

## 다음에 읽을 것 — `derivedSymbolData`

인스턴스마다 Figma가 **다시 계산한 결과**가 들어 있다. matsq에 947 인스턴스 2336건.
지금은 통째로 무시하고 마스터 좌표를 그대로 쓴다.

한 항목의 실제 내용 (124px 마스터를 74px로 줄인 Button 인스턴스):
```
75:591 > 72:2379   strokeGeometry          <- 이 인스턴스 크기로 다시 아웃라인된 것
75:592             derivedTextData, size, transform
75:593 > 72:2329   strokeGeometry
75:1037            size {74, 44}           <- 마스터 루트 자신
```

이걸 적용하면 리사이즈된 인스턴스의 자식들이 제자리를 찾는다. 지금은 74px 버튼이
마스터의 136px 배치를 그대로 써서 라벨이 배경 밖으로 나간다.

**한 번 시도했다가 되돌렸다.** `guidPath.guids`를 마스터 루트 기준 경로로 키를 잡아
병합했더니, 손대지 않은 136px 버튼의 텍스트가 44px에서 112px로 부풀어 양옆 아이콘과
겹쳤다. 경로가 무엇을 기준으로 하는지, `size`/`transform`이 어느 좌표계인지 아직 모른다.
다음 사람은 **경로 의미부터 확정**할 것 — 같은 마스터를 두 번 품은 인스턴스에서
마지막 guid만으로 키를 잡으면 충돌한다는 것도 함께.

## 문서를 고칠 때

이 문서와 `CLAUDE.md`의 수치는 census 출력에서 온다. 바꿀 때 둘 다 다시 돌려서 맞출 것.
**부정을 쓰기 전에 전수 조사할 것** — "이 파일엔 없다"를 두 번 틀렸고, 둘 다
필드 이름 한 가지 모양만 grep하고 없다고 단정한 결과였다.

---

## 검증 규약 (작업마다)

1. `pnpm test` 통과
2. `pnpm census`와 `pnpm census samples/matsq.fig` 둘 다. 유실 노드는 **절대값 0**
3. 두 샘플에서 프레임 **여러 개** 렌더하고 스크린샷 육안 확인. 한 프레임으로 끝내지 말 것 —
   지금까지 나온 버그 대부분이 처음 본 프레임에서는 멀쩡해 보였다
4. IR 구조를 바꾸는 변경은 **절대 좌표 집합 대조**로 검증할 것. 모든 프레임의 모든 노드에 대해
   부모 오프셋을 누적한 좌표를 정렬해 변경 전후 diff → 일치. 의도적으로 노드가 빠지는 변경이면
   제거만 있고 이동이 없어야 한다
5. 새 단언은 **고의 파손으로 실패를 본 뒤** 커밋. 이 확인을 안 해서 공허한 단언 3개가
   통과하고 있었고, 그중 하나는 감사가 찾을 때까지 불변식 하나를 무방비로 두었다

렌더: chrome-devtools MCP `new_page(file:///…/index.html)` → `resize_page(1440,960)` → `take_screenshot`

## 하지 말 것

- `get_html`을 프로덕션 마크업으로 만들기. 기하 기준선·대조용이다
- 샘플 없이 기능 추가
- 벡터 네트워크 blob 파서. 실패하는 blob은 `fillGeometry`/`strokeGeometry`의 중복 표현이고,
  둘 중 어느 것으로도 참조되지 않음을 두 파일에서 확인했다
- OpenPencil/Figma MCP 재도입. 그 한계가 이 프로젝트의 존재 이유다
