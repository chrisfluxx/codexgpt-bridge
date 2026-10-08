# CodexGPT Bridge

**ChatGPT 웹 모델을 Codex에서 사용하세요.**

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

CodexGPT Bridge는 Codex를 로그인된 ChatGPT 웹 세션에 연결합니다.
모델 선택, 작업별 대화, 이미지, 진행 상황 표시 및 취소를 지원합니다.
프로젝트 파일, 도구 및 승인은 Codex에서 관리합니다.

이 프로젝트는 독립적인 타사 프로젝트이며 OpenAI와 제휴 관계가 없습니다.

GPT 플러그인 및 Full MCP 설정 안내: [English](README.md#chatgpt-plugin-setup) · [繁體中文](README.zh-TW.md#chatgpt-外掛設定).

## 설치

이 저장소의 **[Releases](https://github.com/chrisfluxx/codexgpt-bridge/releases/latest)** 페이지에서 운영 체제에 맞는 설치 파일을 다운로드하세요.
Windows는 `CodexGPT-Bridge-Setup-<버전>.exe`, macOS는 DMG,
Linux는 AppImage 또는 DEB를 사용합니다.

Codex가 설치되어 있어야 하며, 사용할 모델에 접근할 수 있는 ChatGPT 계정이 필요합니다.
사용 가능한 모델과 사용 한도는 계정에 따라 다릅니다.

## 시작하기

1. Bridge를 열고 브라우저와 도구 연결 방식을 선택하세요.
   처음 사용한다면 Simple이 가장 간편합니다. Full MCP는 커넥터와 tunnel 설정이 필요합니다.
2. 'ChatGPT 로그인 열기'를 선택하고 로그인하세요. Chrome에서 로그인을 마쳤다면
   Bridge로 돌아와 '로그인 완료, 계속'을 선택하세요.
3. 'ChatGPT 연결 테스트'를 선택한 다음 'Web 모델 설치'를 선택하세요.
4. Codex를 다시 시작하고 `CodexGPT Bridge — …` 모델을 선택하세요.

모델을 사용하는 동안 Bridge를 계속 실행해 주세요.
메인 창을 닫으면 시스템 트레이에 남아 있으며, '종료'를 선택하면 프로그램이 중지됩니다.
'Web 모델 제거'는 Bridge가 관리하던 설정을 이전 상태로 복원합니다.

인터페이스는 영어, 번체 중국어, 간체 중국어, 일본어 및 한국어를 지원합니다.
'언어' 메뉴에서 전환할 수 있습니다.

## 업데이트 및 문제 해결

GitHub 릴리스 워크플로는 이 저장소의 업데이트 주소를 설치 파일에 포함합니다.
사용자가 업데이트 주소를 직접 입력할 필요는 없습니다.
Bridge는 시작 시와 백그라운드 실행 중에 새 버전을 확인합니다.
온라인 업데이트를 사용하려면 업데이트 매니페스트와 설치 파일에 접근할 수 있어야 합니다.
업데이트 소스를 아직 사용할 수 없다면 **[Releases](https://github.com/chrisfluxx/codexgpt-bridge/releases/latest)**에서 새 버전을 다운로드하세요.

연결에 실패하면 ChatGPT 로그인 상태를 확인한 뒤 Bridge의 **Doctor** 진단을 실행하세요.
문제를 보고할 때는 앱 버전, 운영 체제 및 재현 단계를 포함하고,
계정 정보, 개인 경로, 대화 내용 및 인증 정보를 제거해 주세요.

로그인 데이터와 설정은 애플리케이션의 로컬 사용자 프로필에 저장됩니다.

## 소스 코드에서 실행

Node.js 22.20.0 이상과 pnpm 11.19.0을 사용하세요.

```powershell
pnpm install --frozen-lockfile
pnpm desktop
```

## 타사 라이선스

의존성 패키지의 라이선스는 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)와
`LICENSES/`에 포함되어 있습니다. 프로젝트 라이선스는 아직 선택되지 않았습니다.
