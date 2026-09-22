import colyseus from 'colyseus';
const { Server, Room } = colyseus;
type Client = colyseus.Client;
import { Schema, type, MapSchema } from '@colyseus/schema';
import { createServer } from 'http';

// ==========================================
// 1. Colyseus State Schemas (同期用ステート)
// ==========================================

export class VoxelBlockState extends Schema {
  @type("string") id: string = "";
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") z: number = 0;
  @type("string") type: string = "dirt"; // dirt, grass, stone, wood, leaves
}

export class PlayerState extends Schema {
  @type("string") id: string = "";
  @type("string") name: string = "Player";
  @type("number") x: number = 0;
  @type("number") y: number = 0.5;
  @type("number") z: number = 0;
  @type("number") rotationY: number = 0;
  @type("string") currentAction: string = "idle"; // idle, mining, building
  @type("number") targetVoxelX: number = 0;
  @type("number") targetVoxelZ: number = 0;
  @type("number") lastActionTime: number = 0;
}

export class NPCState extends Schema {
  @type("string") id: string = "";
  @type("string") name: string = "村人AI";
  @type("number") x: number = 0;
  @type("number") y: number = 0.5;
  @type("number") z: number = 0;
  @type("number") targetX: number = 0;
  @type("number") targetZ: number = 0;
  @type("string") currentTask: string = "見回り中";
  @type("string") currentGoal: string = "村のパトロール";
  @type("string") statusMessage: string = "今日も良い天気だなあ";
}

export class GameWorldState extends Schema {
  @type({ map: VoxelBlockState }) voxels = new MapSchema<VoxelBlockState>();
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: NPCState }) npcs = new MapSchema<NPCState>();
}

// ==========================================
// 2. GOAP (Goal-Oriented Action Planning) エンジン
// ==========================================

export interface WorldStateFacts {
  [key: string]: boolean | number | string;
}

export interface GOAPGoal {
  name: string;
  priority: number;
  preconditions: WorldStateFacts;
}

export interface GOAPAction {
  name: string;
  cost: number;
  preconditions: WorldStateFacts;
  effects: WorldStateFacts;
  targetX?: number;
  targetZ?: number;
}

export class GOAPPlanner {
  /**
   * 現在の環境事実（Facts）から最も優先度の高い目標を選択し、実行プランを生成する
   */
  public plan(
    currentFacts: WorldStateFacts,
    goals: GOAPGoal[],
    availableActions: GOAPAction[]
  ): { goal: GOAPGoal; planSequence: GOAPAction[] } | null {
    // 優先度順にソートした目標リスト
    const sortedGoals = [...goals].sort((a, b) => b.priority - a.priority);

    for (const goal of sortedGoals) {
      if (this.isSatisfied(currentFacts, goal.preconditions)) {
        // 既に満たされている目標はスキップ
        continue;
      }

      const planSequence = this.findActionSequence(currentFacts, goal.preconditions, availableActions);
      if (planSequence && planSequence.length > 0) {
        return { goal, planSequence };
      }
    }

    return null;
  }

  private isSatisfied(current: WorldStateFacts, required: WorldStateFacts): boolean {
    for (const key in required) {
      if (current[key] !== required[key]) {
        return false;
      }
    }
    return true;
  }

  private findActionSequence(
    currentFacts: WorldStateFacts,
    targetState: WorldStateFacts,
    actions: GOAPAction[]
  ): GOAPAction[] | null {
    // 簡易探索 (A* / 後退探索の軽量実装)
    const validActions = actions.filter((action) => {
      // 少なくとも1つの効果が目標状態に寄与するか確認
      for (const key in targetState) {
        if (action.effects[key] === targetState[key]) return true;
      }
      return false;
    });

    if (validActions.length === 0) return null;
    // 最もコストの低いアクションを選択
    validActions.sort((a, b) => a.cost - b.cost);
    return [validActions[0]];
  }
}

// ==========================================
// 3. Colyseus Authoritative Game Room
// ==========================================

export class VoxelGameRoom extends Room<GameWorldState> {
  private goapPlanner = new GOAPPlanner();
  private simulationInterval: any = null;

  onCreate(options: any) {
    this.setState(new GameWorldState());

    // 初期マップ生成 (20x20の地面 + 中央付近の木)
    this.generateInitialWorld();

    // 手助け型自律NPCの配置
    this.spawnDefaultNPCs();

    // メッセージハンドラーの登録
    this.setupMessageHandlers();

    // サーバーシミュレーションループ (10Hz: 100ms周期)
    this.simulationInterval = setInterval(() => {
      this.updateNPCAIGoapLoop();
    }, 100);

    console.log("🌲 [VoxelGameRoom] Authoritative Room initialized with GOAP AI Loop (10Hz).");
  }

  onJoin(client: Client, options: any) {
    const player = new PlayerState();
    player.id = client.sessionId;
    player.name = options.name || `Player_${client.sessionId.substring(0, 4)}`;
    player.x = 0;
    player.y = 0.5;
    player.z = 0;

    this.state.players.set(client.sessionId, player);
    console.log(`👤 [Join] Player ${player.name} (${client.sessionId}) joined.`);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    console.log(`🚪 [Leave] Player (${client.sessionId}) disconnected.`);
  }

  onDispose() {
    if (this.simulationInterval) {
      clearInterval(this.simulationInterval);
    }
  }

  // --- 初期ワールドの生成 ---
  private generateInitialWorld(): void {
    const size = 20;
    for (let x = -size / 2; x < size / 2; x++) {
      for (let z = -size / 2; z < size / 2; z++) {
        const voxel = new VoxelBlockState();
        voxel.id = `v_${x}_0_${z}`;
        voxel.x = x;
        voxel.y = 0;
        voxel.z = z;
        voxel.type = (Math.abs(x) < 3 && Math.abs(z) < 3) ? "dirt" : "grass";
        this.state.voxels.set(voxel.id, voxel);
      }
    }

    // 木の配置 (原木 + 葉っぱ)
    const treePositions = [[-5, -4], [6, 5], [-6, 6], [4, -6]];
    treePositions.forEach(([tx, tz]) => {
      for (let y = 1; y <= 3; y++) {
        const trunk = new VoxelBlockState();
        trunk.id = `v_${tx}_${y}_${tz}`;
        trunk.x = tx;
        trunk.y = y;
        trunk.z = tz;
        trunk.type = "wood";
        this.state.voxels.set(trunk.id, trunk);
      }
      for (let lx = tx - 1; lx <= tx + 1; lx++) {
        for (let lz = tz - 1; lz <= tz + 1; lz++) {
          const leaf = new VoxelBlockState();
          leaf.id = `v_${lx}_4_${lz}`;
          leaf.x = lx;
          leaf.y = 4;
          leaf.z = lz;
          leaf.type = "leaves";
          this.state.voxels.set(leaf.id, leaf);
        }
      }
    });
  }

  // --- NPCの初期生成 ---
  private spawnDefaultNPCs(): void {
    const npc1 = new NPCState();
    npc1.id = "npc_pico";
    npc1.name = "お手伝いピコ";
    npc1.x = 2;
    npc1.y = 0.5;
    npc1.z = 2;
    npc1.targetX = 2;
    npc1.targetZ = 2;
    npc1.currentTask = "プレイヤー探索中";
    npc1.statusMessage = "何か手伝えることはあるかな？";
    this.state.npcs.set(npc1.id, npc1);
  }

  // --- メッセージハンドラー群 ---
  private setupMessageHandlers(): void {
    // 移動メッセージ (y座標およびrotY/rotationYの互換性を両立)
    this.onMessage("player_move", (client, data: { x: number; y?: number; z: number; rotationY?: number; rotY?: number }) => {
      const player = this.state.players.get(client.sessionId);
      if (player) {
        player.x = data.x;
        if (data.y !== undefined) player.y = data.y;
        player.z = data.z;
        player.rotationY = data.rotationY ?? data.rotY ?? 0;
      }
    });

    // プレイヤーの作業（採掘/建設）通知 (action/actionType, x/targetX の互換性を両立)
    this.onMessage("player_action", (client, data: { action?: string; actionType?: string; targetX?: number; targetZ?: number; x?: number; z?: number }) => {
      const player = this.state.players.get(client.sessionId);
      if (player) {
        player.currentAction = data.action || data.actionType || "idle";
        player.targetVoxelX = data.targetX ?? data.x ?? 0;
        player.targetVoxelZ = data.targetZ ?? data.z ?? 0;
        player.lastActionTime = Date.now();
      }
    });

    // ボクセル破壊（採掘）
    this.onMessage("destroy_voxel", (client, data: { x: number; y: number; z: number }) => {
      const voxelId = `v_${data.x}_${data.y}_${data.z}`;
      if (this.state.voxels.has(voxelId)) {
        this.state.voxels.delete(voxelId);
        
        // 採掘を行ったプレイヤーのアクション更新
        const player = this.state.players.get(client.sessionId);
        if (player) {
          player.currentAction = "mining";
          player.targetVoxelX = data.x;
          player.targetVoxelZ = data.z;
          player.lastActionTime = Date.now();
        }

        // 他クライアントへ破壊イベントを通知
        this.broadcast("voxel_destroyed", { x: data.x, y: data.y, z: data.z, bySessionId: client.sessionId }, { except: client });
      }
    });

    // ボクセル配置（建設）
    this.onMessage("place_voxel", (client, data: { x: number; y: number; z: number; type: string }) => {
      const voxelId = `v_${data.x}_${data.y}_${data.z}`;
      if (!this.state.voxels.has(voxelId)) {
        const newVoxel = new VoxelBlockState();
        newVoxel.id = voxelId;
        newVoxel.x = data.x;
        newVoxel.y = data.y;
        newVoxel.z = data.z;
        newVoxel.type = data.type || "dirt";
        this.state.voxels.set(voxelId, newVoxel);

        // 建設を行ったプレイヤーのアクション更新
        const player = this.state.players.get(client.sessionId);
        if (player) {
          player.currentAction = "building";
          player.targetVoxelX = data.x;
          player.targetVoxelZ = data.z;
          player.lastActionTime = Date.now();
        }

        // 他クライアントへ配置イベントを通知
        this.broadcast("voxel_placed", { x: data.x, y: data.y, z: data.z, type: newVoxel.type, bySessionId: client.sessionId }, { except: client });
      }
    });
  }

  // --- GOAP AI ループ (最優先: プレイヤー手助け) ---
  private updateNPCAIGoapLoop(): void {
    const now = Date.now();

    this.state.npcs.forEach((npc) => {
      // 1. 周辺プレイヤーのセンシングと手助け判定
      let activePlayerNear: PlayerState | null = null;
      let minDistance = 15.0; // 感知範囲

      this.state.players.forEach((player) => {
        const dx = player.x - npc.x;
        const dz = player.z - npc.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        // 過去10秒以内に採掘・建設を行ったプレイヤーを感知
        const isRecentlyActive = (now - player.lastActionTime) < 10000;
        if (dist < minDistance && (isRecentlyActive || player.currentAction !== "idle")) {
          minDistance = dist;
          activePlayerNear = player;
        }
      });

      // 2. GOAP 事実（Facts）の構成
      const facts: WorldStateFacts = {
        playerNeedsHelp: activePlayerNear !== null,
        atTargetLocation: Math.abs(npc.x - npc.targetX) < 0.8 && Math.abs(npc.z - npc.targetZ) < 0.8,
        hasVillageWork: true
      };

      // 3. GOAP 目標（Goals）の設定（優先度付け）
      const goals: GOAPGoal[] = [
        {
          name: "HelpPlayerActive",
          priority: activePlayerNear ? 100 : 0, // プレイヤー手助けが最優先 (Priority 100)
          preconditions: { isAssistingPlayer: true }
        },
        {
          name: "PatrolAndMaintainVillage",
          priority: 20, // 平常時の村巡回・整備 (Priority 20)
          preconditions: { villagePatrolled: true }
        }
      ];

      // 4. 利用可能な GOAP アクション
      const actions: GOAPAction[] = [];

      if (activePlayerNear) {
        const targetP: PlayerState = activePlayerNear;
        actions.push({
          name: "ApproachAndAssistPlayer",
          cost: 1,
          preconditions: { playerNeedsHelp: true },
          effects: { isAssistingPlayer: true },
          targetX: targetP.x + 1, // プレイヤーの隣に駆けつける
          targetZ: targetP.z + 1
        });
      } else {
        // プレイヤーが暇な時はランダムパトロール
        const wanderX = (Math.sin(now * 0.001) * 6);
        const wanderZ = (Math.cos(now * 0.001) * 6);
        actions.push({
          name: "WanderAroundVillage",
          cost: 5,
          preconditions: { hasVillageWork: true },
          effects: { villagePatrolled: true },
          targetX: wanderX,
          targetZ: wanderZ
        });
      }

      // 5. GOAP プランニング実行
      const result = this.goapPlanner.plan(facts, goals, actions);

      if (result && result.planSequence.length > 0) {
        const currentAction = result.planSequence[0];

        if (currentAction.targetX !== undefined && currentAction.targetZ !== undefined) {
          npc.targetX = currentAction.targetX;
          npc.targetZ = currentAction.targetZ;
        }

        // 行動とステータスメッセージの更新
        if (result.goal.name === "HelpPlayerActive" && activePlayerNear) {
          const targetP: PlayerState = activePlayerNear;
          npc.currentGoal = "プレイヤーの手助け";
          npc.currentTask = `${targetP.name}の作業 (${targetP.currentAction === "mining" ? "採掘" : "建設"}) を補助中`;
          npc.statusMessage = `${targetP.name}さん！その作業、手伝いますよ！`;
        } else {
          npc.currentGoal = "村のパトロール";
          npc.currentTask = "集落の周回チェック";
          npc.statusMessage = "村に異常なし！プレイヤーさんは元気かな？";
        }
      }

      // 6. NPCの位置移動（ターゲット方向へ補間移動）
      const dx = npc.targetX - npc.x;
      const dz = npc.targetZ - npc.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist > 0.2) {
        const speed = 0.15; // 100msあたりの移動量
        npc.x += (dx / dist) * speed;
        npc.z += (dz / dist) * speed;
      }
    });
  }
}

// ==========================================
// 4. サーバー起動処理
// ==========================================

const port = Number(process.env.PORT || 2567);
const gameServer = new Server({
  server: createServer()
});

gameServer.define('voxel_room', VoxelGameRoom);

gameServer.listen(port).then(() => {
  console.log(`
  ======================================================
  🌲 Voxel Village Colyseus Server is Live!
  📡 WebSocket Endpoint: ws://localhost:${port}
  🧠 GOAP Helper NPC Engine Active (Tick: 100ms)
  ======================================================
  `);
});
