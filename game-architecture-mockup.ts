/**
 * ============================================================================
 * ボクセル箱庭マルチプレイヤーゲーム Architecture Mockup Code
 * ============================================================================
 * 
 * 構造概要:
 * 1. [Client] ECS & Three.js Isometric Voxel Render System
 * 2. [Server] Colyseus Authoritative Game Room & State Schema
 * 3. [AI Engine] Rule-based / GOAP Hybrid NPC Agent System
 */

import * as THREE from 'three';

// ============================================================================
// 1. [CLIENT] Three.js + ECS クォータービュー & ボクセル描画システム
// ============================================================================

export interface Component {
  type: string;
}

export class PositionComponent implements Component {
  type = 'Position';
  constructor(public x: number, public y: number, public z: number) {}
}

export class RenderComponent implements Component {
  type = 'Render';
  constructor(public meshId: string, public isInstanced: boolean = true) {}
}

export class AgentComponent implements Component {
  type = 'Agent';
  constructor(public agentType: 'PLAYER' | 'NPC', public state: string = 'IDLE') {}
}

export class Entity {
  public id: string;
  public components: Map<string, Component> = new Map();

  constructor(id: string) {
    this.id = id;
  }

  addComponent(component: Component): void {
    this.components.set(component.type, component);
  }

  getComponent<T extends Component>(type: string): T | undefined {
    return this.components.get(type) as T;
  }
}

/**
 * クォータービュー（アイソメトリック）カメラ制御システム
 */
export class IsometricCameraSystem {
  public camera: THREE.OrthographicCamera;
  private aspect: number;
  private d: number = 20;

  constructor(aspectRatio: number) {
    this.aspect = aspectRatio;
    // アイソメトリック（等角投影）カメラの設定
    this.camera = new THREE.OrthographicCamera(
      -this.d * this.aspect,
      this.d * this.aspect,
      this.d,
      -this.d,
      1,
      1000
    );

    // クォータービュー標準アングル (45 deg Y回転, ~35.264 deg X回転)
    this.camera.position.set(20, 20, 20);
    this.camera.lookAt(0, 0, 0);
  }

  public followTarget(targetX: number, targetY: number, targetZ: number): void {
    const offset = new THREE.Vector3(20, 20, 20);
    this.camera.position.set(targetX + offset.x, targetY + offset.y, targetZ + offset.z);
    this.camera.lookAt(targetX, targetY, targetZ);
  }
}

/**
 * InstancedMeshを活用した高速ボクセル・環境描写レンダラー
 */
export class VoxelInstancedRenderer {
  private scene: THREE.Scene;
  private instancedMeshes: Map<number, THREE.InstancedMesh> = new Map();
  private maxInstances: number = 10000;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.initInstancedMeshPool();
  }

  private initInstancedMeshPool(): void {
    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    
    // Type 1: Dirt/Grass, Type 2: Wood/Tree Block, Type 3: Stone
    const materials = [
      new THREE.MeshStandardMaterial({ color: 0x55aa55 }), // Grass/Dirt
      new THREE.MeshStandardMaterial({ color: 0x8b5a2b }), // Wood
      new THREE.MeshStandardMaterial({ color: 0x888888 }), // Stone
    ];

    materials.forEach((mat, idx) => {
      const instancedMesh = new THREE.InstancedMesh(boxGeometry, mat, this.maxInstances);
      instancedMesh.count = 0;
      instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(instancedMesh);
      this.instancedMeshes.set(idx + 1, instancedMesh);
    });
  }

  /**
   * ボクセルのリアルタイム削除（木を切るなどのインタラクション時）
   * アニメーションなしで即時再構築・非表示化
   */
  public removeVoxel(typeId: number, instanceIndex: number): void {
    const mesh = this.instancedMeshes.get(typeId);
    if (!mesh || instanceIndex >= mesh.count) return;

    const dummy = new THREE.Object3D();
    dummy.position.set(0, -9999, 0); // 画面外へ即時移動
    dummy.updateMatrix();
    mesh.setMatrixAt(instanceIndex, dummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
  }
}

// ============================================================================
// 2. [SERVER] Colyseus Authoritative リアルタイム同期 サーバー定義
// ============================================================================

export interface NetworkVoxelData {
  id: string;
  x: number;
  y: number;
  z: number;
  typeId: number;
}

export interface NetworkNPCData {
  id: string;
  x: number;
  y: number;
  z: number;
  action: string;
  targetPlayerId?: string;
}

/**
 * Colyseus Authoritative Game Room モックアップ
 */
export class VoxelGameRoom {
  private state = {
    voxels: new Map<string, NetworkVoxelData>(),
    players: new Map<string, { x: number; y: number; z: number }>(),
    npcs: new Map<string, NetworkNPCData>(),
  };

  public onCreate(): void {
    console.log("[Server] VoxelGameRoom created.");
    this.setupWorld();
  }

  private setupWorld(): void {
    // マップ初期生成 (10x10の木・ボクセル配置)
    for (let x = 0; x < 10; x++) {
      for (let z = 0; z < 10; z++) {
        const id = `${x}_0_${z}`;
        this.state.voxels.set(id, { id, x, y: 0, z, typeId: 1 });
      }
    }
  }

  /**
   * プレイヤー/NPCによる樹木伐採・環境変化リクエストの処理
   */
  public handleVoxelCut(playerId: string, voxelId: string): void {
    const voxel = this.state.voxels.get(voxelId);
    if (voxel) {
      console.log(`[Server] Player ${playerId} cut voxel ${voxelId}. Immediate removal.`);
      this.state.voxels.delete(voxelId); // リアルタイムで削除同期
    }
  }

  public updateNPCPositions(npcId: string, x: number, y: number, z: number, action: string): void {
    const npc = this.state.npcs.get(npcId);
    if (npc) {
      npc.x = x;
      npc.y = y;
      npc.z = z;
      npc.action = action;
    }
  }
}

// ============================================================================
// 3. [AI ENGINE] 軽量 GOAP & 優先度付き自律NPCエージェント
// ============================================================================

export interface GOAPWorldState {
  [key: string]: boolean | number | string;
}

export interface GOAPAction {
  name: string;
  cost: number;
  preconditions: GOAPWorldState;
  effects: GOAPWorldState;
}

export interface Goal {
  name: string;
  priority: number;
  targetState: GOAPWorldState;
}

/**
 * A* アルゴリズムに基づく軽量GOAPプランナー
 */
export class GOAPPlanner {
  public plan(
    initialState: GOAPWorldState,
    goal: GOAPWorldState,
    actions: GOAPAction[]
  ): GOAPAction[] | null {
    // 簡易プランニング演算 (条件に合致するアクションチェーンの構築)
    const plan: GOAPAction[] = [];
    let currentState = { ...initialState };

    for (const action of actions) {
      if (this.checkPreconditions(currentState, action.preconditions)) {
        plan.push(action);
        currentState = { ...currentState, ...action.effects };
        if (this.checkGoalReached(currentState, goal)) {
          return plan;
        }
      }
    }
    return plan.length > 0 ? plan : null;
  }

  private checkPreconditions(state: GOAPWorldState, preconditions: GOAPWorldState): boolean {
    for (const key in preconditions) {
      if (state[key] !== preconditions[key]) return false;
    }
    return true;
  }

  private checkGoalReached(state: GOAPWorldState, goal: GOAPWorldState): boolean {
    for (const key in goal) {
      if (state[key] !== goal[key]) return false;
    }
    return true;
  }
}

/**
 * プレイヤー補助最優先の自律型NPCエージェントクラス
 */
export class NextGenNPCAgent {
  public id: string;
  public position: { x: number; y: number; z: number };
  private planner: GOAPPlanner;
  private currentGoal: Goal | null = null;
  private actionQueue: GOAPAction[] = [];

  constructor(id: string, initialPos: { x: number; y: number; z: number }) {
    this.id = id;
    this.position = initialPos;
    this.planner = new GOAPPlanner();
  }

  /**
   * 周囲の状況（プレイヤーの有無）に応じて目標の優先度を評価
   */
  public evaluateGoals(
    nearbyPlayers: Array<{ id: string; x: number; y: number; z: number; isBuilding: boolean }>,
    availableVoxels: Array<{ id: string; x: number; z: number }>
  ): Goal {
    // 規則1: 近くに建設・作業中のプレイヤーがいれば「プレイヤー補助」が最優先 (Priority 100)
    const targetPlayer = nearbyPlayers.find((p) => this.getDistance(p) < 10 && p.isBuilding);
    if (targetPlayer) {
      return {
        name: "ASSIST_PLAYER",
        priority: 100,
        targetState: { playerAssisted: true },
      };
    }

    // 規則2: プレイヤーが居なければ「自律木こり・建設」 (Priority 50)
    if (availableVoxels.length > 0) {
      return {
        name: "HARVEST_WOOD",
        priority: 50,
        targetState: { hasWood: true },
      };
    }

    // 規則3: パトロール / Idle (Priority 10)
    return {
      name: "IDLE_PATROL",
      priority: 10,
      targetState: { isPatrolling: true },
    };
  }

  public update(nearbyPlayers: any[], availableVoxels: any[]): void {
    const newGoal = this.evaluateGoals(nearbyPlayers, availableVoxels);

    if (!this.currentGoal || this.currentGoal.name !== newGoal.name) {
      this.currentGoal = newGoal;
      console.log(`[NPC:${this.id}] New Active Goal: ${newGoal.name} (Priority: ${newGoal.priority})`);
      this.replan();
    }

    this.executeNextAction();
  }

  private replan(): void {
    // 利用可能な定義済み基本アクション（ローカル実行型）
    const availableActions: GOAPAction[] = [
      {
        name: "MoveToPlayer",
        cost: 1,
        preconditions: {},
        effects: { nearPlayer: true },
      },
      {
        name: "SupplyMaterials",
        cost: 1,
        preconditions: { nearPlayer: true },
        effects: { playerAssisted: true },
      },
      {
        name: "CutTreeVoxel",
        cost: 2,
        preconditions: {},
        effects: { hasWood: true },
      },
    ];

    const plan = this.planner.plan({}, this.currentGoal?.targetState || {}, availableActions);
    if (plan) {
      this.actionQueue = plan;
    }
  }

  private executeNextAction(): void {
    if (this.actionQueue.length > 0) {
      const action = this.actionQueue.shift();
      console.log(`[NPC:${this.id}] Executing Action: ${action?.name}`);
    }
  }

  private getDistance(pos: { x: number; z: number }): number {
    const dx = this.position.x - pos.x;
    const dz = this.position.z - pos.z;
    return Math.sqrt(dx * dx + dz * dz);
  }
}
