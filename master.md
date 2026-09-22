# ボクセル箱庭マルチプレイヤーゲーム マスター設計書 (master.md)

> 本ドキュメントは、クォータービュー（アイソメトリック）形式のボクセル箱庭マルチプレイヤーゲームおよび自律型NPCシステムの要素分解と全体アーキテクチャを定義したものです。他チャット（実装用LLMプロンプト）へのコンテキスト引き渡し用として使用します。

---

## 1. プロジェクト概要 & コアコンセプト

* **ゲームジャンル**: クォータービュー・ボクセル箱庭クラフト＆協調シミュレーション [1, 3]
* **視点 (Camera)**: 2.5D アイソメトリック（クォータービュー固定・ドラッグ平行移動 / ズーム対応） [3]
* **世界観・マップ**: ボクセル（Voxel）グリッドで構成された箱庭世界。木や岩などの各種環境オブジェクトが存在 [1]
* **ゲームプレイ方針**:
  * **戦闘なし**: 平和的な素材収集・建設・開拓に特化。
  * **環境即時変化**: アニメーション補間を最小限にし、木を斧で叩いて切ると即座に消失・アイテム化するなど、高速でレスポンシブなインタラクションを提供 [1, 5]。
* **NPCの役割と動作モデル**:
  * あらかじめ定義された行動パターンと **GOAP (Goal-Oriented Action Planning)** に基づく高速・軽量な自律動作 [4]。
  * **優先度制御**: プレイヤーが近くに居る場合は最優先でその手助け（建設支援・資材運搬）を行う。
  * **API非依存**: 重いLLM APIの常用を避け、ローカルルール/GOAPで完結。必要に応じて非同期LLMを接続可能なハイブリッド構造 [4]。

---

## 2. 技術スタック概要

| 領域 | 採用技術 | 役割 | 関連ソース |
| :--- | :--- | :--- | :--- |
| **Client Rendering** | Three.js + TypeScript | 2.5D アイソメトリック描画、ボクセル・インスタンス描画 | [3, 5] |
| **Client Architecture** | Entity Component System (ECS) | ロジックと描画の分離、オブジェクトプール管理 | [3] |
| **Server Engine** | Node.js + Colyseus | Authoritative リアルタイム同期サーバー、Schema状態管理 | [2] |
| **AI Autonomous Engine** | TS/Node.js GOAP Engine | 低遅延アクション計画、タスク優先度キュー | [4] |
| **Data Optimization** | Bitwise Voxel Data & InstancedMesh | 大量ボクセル/樹木の描画・メモリ最適化 | [1, 5] |

---

## 3. システム要素分解 (System Decomposition)

### 【モジュール A】クライアント & レンダリング層 (Client / Three.js + ECS)

1. **IsometricCameraSystem [3]**
   * 直交投影（`OrthographicCamera`）を用いたクォータービュー画角の維持。
   * プレイヤー追従・スムーズスクロール。
2. **VoxelRenderSystem [1]**
   * グリッド座標に基づくボクセルブロックの描画・更新。
   * インスタンスドメッシュ（`InstancedMesh`）による一括描画と高速レイキャスト検出 [3, 5]。
3. **EnvironmentInteractionSystem [1, 5]**
   * 木の伐採やブロック破壊/設置時の即時描画更新（アニメーション省略型）。
   * オブジェクトプール（`ObjectPool`）によるパーティクル/ドロップアイテムの管理 [3]。
4. **ECS Core (Entity Component System) [3]**
   * Entity: プレイヤー、NPC、環境オブジェクト（木・岩・建設物）。
   * Components: `PositionComponent`, `RenderComponent`, `VoxelDataComponent`, `AgentComponent`.

### 【モジュール B】マルチプレイヤー & サーバー状態管理層 (Server / Colyseus)

1. **GameRoom (Colyseus Room) [2]**
   * Authoritative サーバーとして全状態（プレイヤー位置、Voxelデータ、NPC状態）を一元管理。
   * 1秒間に20〜30回の状態同期ループ。
2. **WorldState Schema [2]**
   * `voxels`: マップ上の変更されたボクセルデータマップ（`MapSchema<VoxelState>`）。
   * `players`: 接続プレイヤーの座標・所持資材（`MapSchema<PlayerState>`）。
   * `npcs`: 全NPCの座標・現在の目標・行動ステート（`MapSchema<NPCState>`）。
3. **WorldMutationHandler [1, 2]**
   * プレイヤー/NPCからの「採掘」「設置」アクションの検証と状態適用。
   * インベントリ管理と資材ドロップの同期。

### 【モジュール C】自律型NPC & GOAP行動計画層 (AI / GOAP Engine)

1. **PrioritizedGoalSelector (目標決定エンジン) [4]**
   * **Priority Level 1 (最高)**: プレイヤー補助 (Player Assist)
     * 条件: 近接範囲（例: 10グリッド以内）に作業中/移動中のプレイヤーが存在する。
     * 目標: プレイヤーの狙う建設支援、または指定位置への資材運搬。
   * **Priority Level 2**: NPC間協調・会話 (Social Co-op)
     * 条件: 周囲に他NPCが存在する。
     * 目標: あらかじめ定義されたトークンに基づく会話・共同建設。
   * **Priority Level 3**: 自律維持・探索 (Idle / Harvest / Build)
     * 条件: 優先イベントなし。
     * 目標: 街の資材収集（木こり・採掘）、指定エリアの建設。
2. **GOAPPlanner (軽量計画実行機) [4]**
   * WorldState（現在の世界状態）と Goal（達成目標）から Action（行動系列）をA*探索で自動構築。
   * 行動パターン定義: `CutTree`, `GatherWood`, `TransportMaterial`, `BuildStructure`, `AssistPlayer`.
3. **External AI Hybrid Slot (将来拡張用) [4]**
   * 非同期で外部LLM等の意思決定を取得するためのインターフェース（通常時は完全スキップし、固定ルール/GOAPのみで即座に応答）。

---

## 4. データ構造 & スキーマ定義

### A. Voxel & Map State Schema (Colyseus Schema TypeScript)
```typescript
import { Schema, type, MapSchema } from "@colyseus/schema";

export class VoxelState extends Schema {
  @type("int32") x: number = 0;
  @type("int32") y: number = 0;
  @type("int32") z: number = 0;
  @type("uint8") typeId: number = 0; // 0: Air, 1: Dirt, 2: Wood, 3: Stone, etc.
}

export class NPCState extends Schema {
  @type("string") id: string = "";
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") z: number = 0;
  @type("string") currentAction: string = "IDLE";
  @type("string") targetPlayerId: string = ""; // 補助対象のプレイヤーID
}
```

### B. GOAP Action & WorldState (TypeScript)
```typescript
export interface GOAPWorldState {
  [key: string]: boolean | number | string;
}

export interface GOAPAction {
  name: string;
  cost: number;
  preconditions: GOAPWorldState;
  effects: GOAPWorldState;
  execute: (agentId: string, world: any) => Promise<boolean>;
}
```

---

## 5. 他チャットへ渡すための実装プロンプト文脈 (Prompt Template)

以下をコピーして別の開発チャットに貼り付けることで、特定モジュールの詳細実装を開始できます。

```text
【開発コンテキスト】
あなたはクォータービュー・ボクセル箱庭ゲームの開発者です。
参照ドキュメント master.md に基づき、以下のモジュールを実装してください。

■ 今回の実装対象: [例: モジュール C: GOAP行動計画エンジン]
■ 要求仕様:
- 戦闘なし、建設・収集中心。
- プレイヤーが近くに居る場合はプレイヤー手助け目標を最優先に選定する GOAPPlanner を構築してください。
- 外部APIに依存せず、完全ローカルの高速ルールで動作するクラスとして記述してください。
```
