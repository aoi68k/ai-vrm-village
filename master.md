# ボクセル箱庭 ＆ VRM自律型NPCマルチプレイヤーゲーム マスター設計書 (master-v2.md)

> 本ドキュメントは、VRMアバター表示、クォータービュー（アイソメトリック）ボクセル箱庭環境、Colyseusリアルタイム同期、およびGOAP手助けAIシステムを包括した最新の全体アーキテクチャ設計書です。他開発チャットや開発プロンプトへの文脈引き渡し用として使用します。  
> GitHub リポジトリ: https://github.com/aoi68k/ai-vrm-village

---

## 1. プロジェクト概要 & コアコンセプト

* **ゲームタイトル / リポジトリ**: `ai-vrm-village` (ボクセル箱庭 × VRMアバター × GOAP自律型NPC)
* **ゲームジャンル**: 2.5D クォータービュー・ボクセル箱庭クラフト＆協調シミュレーション [1, 3]
* **視点 (Camera)**: 2.5D アイソメトリック（`OrthographicCamera`、ターゲット追従、Lerp補正） [3]
* **アバター表現**: ユーザー独自の `.vrm` ファイル読み込み (`@pixiv/three-vrm`)、WASDキー等角移動、ドラッグ＆ドロップ対応。
* **ゲームプレイ方針**:
  * **完全非戦闘**: 平和的な素材収集（木こり・採掘）と建設・レイアウト設計に特化。
  * **即時環境変化**: アニメーション補間を最小限にし、左クリックで即時破壊、右クリックで即時配置。
  * **リアルタイムモーション機能**: 手続き型歩行（関節連動・体重移動・跳ね補正）、作業モーション（ツルハシ振り下ろし・建設ポーズ）、自動まばたき。
* **NPCの役割と動作モデル**:
  * **GOAP (Goal-Oriented Action Planning)** による軽量・低遅延な自律意思決定 [4]。
  * **優先度制御**: プレイヤーの作業（採掘/建設）をセンシングし、近くにアクティブなプレイヤーがいる場合は `Priority 100` で手助け行動を起こす。
  * **API非依存**: 重いLLM APIを使わずローカルルール/GOAPで完結。

---

## 2. 技術スタック & リポジトリ構成

| 領域 | 採用技術 | 役割 | 関連ソース |
| :--- | :--- | :--- | :--- |
| **Client Rendering** | Three.js + `@pixiv/three-vrm` + Vite | 2.5D 描画、ボクセルインスタンス描画、VRMアバター制御・物理演算 | [3, 5] |
| **Client Network** | `colyseus.js` + TypeScript | WebSocket同期 & オフライン自動フォールバック | [2] |
| **Server Engine** | Node.js + Colyseus | Authoritative リアルタイム状態同期（10Hz Loop） | [2] |
| **AI Engine** | TS/Node.js GOAP Engine | プレイヤー作業センシング、優先度選定、行動決定 | [4] |
| **CI/CD / DevOps** | GitHub Actions (Node 22) + Pages | 自動型チェック (`tsc`) & Vite ビルド、GitHub Pages 自動公開 | - |
| **Dev Environment** | GitHub Codespaces / VS Code | `devcontainer.json`, `setup.bat` による一括環境構築 | - |

---

## 3. システム要素分解 (System Decomposition)

### 【モジュール A】クライアント層 (`client.ts`)
1. **IsometricCameraSystem [3]**
   * 直交投影 (`OrthographicCamera`)、アイソメトリック画角 (45°/35.264°)、ターゲット位置への平滑追従 (Lerp)。
2. **VRMAvatarController & Motion Engine**
   * `GLTFLoader` + `VRMLoaderPlugin` による `.vrm` のロード・物理骨格最適化 (`VRMUtils`)。
   * WASD視点適合移動、段差接地処理、ドラッグ＆ドロップアバター変更。
   * 手続き型モーション: 関節連動歩行、採掘（ツールスイング）、建設（配置構え）、自動まばたき (`expressionManager`)。
3. **DynamicVoxelWorld & Raycaster [1, 5]**
   * `InstancedMesh` による起伏地形・樹木の高速描画とレイキャスト位置検出。
   * 左クリック採掘（ブロック消失＋パーティクル）、右クリック設置、ホットキー（1〜5）ブロック切替。
4. **NetworkController (Client Side) [2]**
   * Colyseus 接続管理、10Hz 位置同期、採掘/建設アクション送信、同期NPCの描画・会話オーバーレイ。

### 【モジュール B】サーバー＆マルチプレイヤー層 (`server.ts`)
1. **VoxelGameRoom (Colyseus Room) [2]**
   * Authoritative サーバーとして全状態（ボクセルマップ、プレイヤー位置・アクティビティ、NPCステート）を一括管理。
2. **Colyseus Schema [2]**
   * `VoxelBlockState`: ID、座標、ブロック種類。
   * `PlayerState`: 座標、回転、作業種別 (`isMining`/`isBuilding`)、最終アクティブタイム。
   * `NPCState`: 座標、現在のGoal (`currentGoal`)、Task (`currentTask`)、会話バブル (`statusMessage`)。

### 【モジュール C】GOAP自律AI層 (Server-side AI)
1. **Perception Module (センシング) [4]**
   * 周囲のプレイヤーのアクティブ作業（10秒以内の採掘/建設）をチェック。
2. **PrioritizedGoalSelector [4]**
   * `Priority 100`: `HelpPlayerActive`（近傍プレイヤーの作業を手助けに向かう）
   * `Priority 20`: `PatrolAndMaintainVillage`（平和時の村パトロール）
3. **GOAPPlanner & Execution Loop [4]**
   * 10Hz のサーバー tick で Goal -> Action -> Move/Talk ステートをリアルタイム更新。

### 【モジュール D】DevOps & CI/CD層
1. **GitHub Actions (`.github/workflows/deploy.yml`)**
   * Node 22 環境で `npx tsc --noEmit` 型チェック ➔ Vite ビルド ➔ GitHub Pages 自動デプロイ。
2. **Codespaces / DevContainer (`.devcontainer/devcontainer.json`)**
   * クラウド環境での自動セットアップ、ポート（5173 / 2567）のフォワーディング。

---

## 4. プロジェクトディレクトリ構成

```text
ai-vrm-village/
├── .github/
│   └── workflows/
│       └── deploy.yml          # Node 22 対応 CI/CD & GitHub Pages デプロイ
├── .devcontainer/
│   └── devcontainer.json       # GitHub Codespaces 設定
├── .gitignore                  # 除外設定
├── package.json                # 依存関係定義 (Three.js, @pixiv/three-vrm, Colyseus, Vite)
├── tsconfig.json               # TypeScript設定
├── setup.bat                   # Windows環境一括ビルド・起動バッチ
├── index.html                  # UI & キャンバスエントリーポイント
├── client.ts                   # クライアントメイン (VRM, Three.js, Raycast, Network)
├── server.ts                   # Authoritative サーバー (Colyseus, GOAP AI Engine)
├── master.md                   # 全体設計ドキュメント
└── game-architecture-mockup.ts # 参考用全体モックアップコード
```

---

## 5. 他チャット・他LLMへの開発引き渡し用プロンプト (Prompt Template)

```text
【開発コンテキスト】
あなたは「ai-vrm-village」(クォータービュー・ボクセル箱庭 × VRMアバター × GOAP手助けAI) の開発者です。
リポジトリ: https://github.com/aoi68k/ai-vrm-village
参照ドキュメント master.md に基づき、以下の拡張・修正を実装してください。

■ 今回の実装対象: [例: client.ts の採掘パーティクルおよび効果音 (SE) 再生処理の強化]
■ 必須条件:
- Three.js + @pixiv/three-vrm の構成を維持すること。
- Colyseus の同期メッセージ (destroy_voxel) と連動させること。
- TypeScript の厳密な型チェック (npx tsc --noEmit) が通過するコードを記述すること。
```
