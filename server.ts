import colyseus from 'colyseus';
const { Server, Room } = colyseus;
type Client = colyseus.Client;
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Schema, type, MapSchema } from '@colyseus/schema';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHash } from 'crypto';

// プレイヤー識別用ハッシュ生成ヘルパー (SHA-256)
export function generateUserHash(input: string, prefix = '#'): string {
  return prefix + createHash('sha256').update(input).digest('hex').substring(0, 6);
}

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
  @type("string") userHash: string = ""; // 例: "#a8f3b2" または "~7d2f4a"
  @type("string") authType: string = "guest"; // "github" または "guest"
  @type("string") githubUsername: string = "";
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
  private playerAvatars = new Map<string, string>();
  private playerColors = new Map<string, { hair: string; skin: string; clothing: string }>();
  private playerTextures = new Map<string, { faceDataUrl?: string; bodyDataUrl?: string }>();

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

    // 認証情報と固有ハッシュの設定
    if (options.authType === 'github' && options.githubId) {
      player.authType = 'github';
      player.githubUsername = options.githubUsername || '';
      player.userHash = generateUserHash('gh_' + options.githubId, '#');
    } else {
      player.authType = 'guest';
      const clientIp = (client as any).ref?.remoteAddress || client.sessionId;
      player.userHash = generateUserHash('guest_' + clientIp, '~');
    }

    this.state.players.set(client.sessionId, player);
    console.log(`👤 [Join] Player ${player.name} (${player.authType === 'github' ? '🐱' : '👤'}${player.userHash}) joined.`);

    // 接続したプレイヤー自身に初期ハッシュ・認証情報を即座に返送
    client.send('auth_init', {
      sessionId: client.sessionId,
      userHash: player.userHash,
      authType: player.authType,
      githubUsername: player.githubUsername,
      name: player.name
    });

    // 既存プレイヤーのアバター画像と配色、およびボックスマン前面テクスチャを新規参加者に個別に送信
    this.playerAvatars.forEach((dataUrl, pid) => {
      client.send('player_avatar_broadcast', { id: pid, dataUrl });
    });
    this.playerColors.forEach((colors, pid) => {
      client.send('player_colors_broadcast', { id: pid, ...colors });
    });
    this.playerTextures.forEach((tex, pid) => {
      client.send('player_textures_broadcast', { id: pid, faceDataUrl: tex.faceDataUrl, bodyDataUrl: tex.bodyDataUrl });
    });

    // 1. 新規参加者へ既存の全プレイヤー情報を一括送信
    const existingList: Array<{
      id: string;
      name: string;
      x: number;
      y: number;
      z: number;
      rotationY: number;
      authType: string;
      userHash: string;
      avatarUrl: string;
      colors: { hair: string; skin: string; clothing: string } | null;
    }> = [];
    this.state.players.forEach((p, pid) => {
      if (pid !== client.sessionId) {
        existingList.push({
          id: pid,
          name: p.name,
          x: p.x,
          y: p.y,
          z: p.z,
          rotationY: p.rotationY,
          authType: p.authType,
          userHash: p.userHash,
          avatarUrl: this.playerAvatars.get(pid) || '',
          colors: this.playerColors.get(pid) || null
        });
      }
    });
    client.send('existing_players', { players: existingList });

    // 2. 既存の全プレイヤーへ新プレイヤーの参加を即座に通知
    this.broadcast('player_joined', {
      id: client.sessionId,
      name: player.name,
      x: player.x,
      y: player.y,
      z: player.z,
      rotationY: player.rotationY,
      authType: player.authType,
      userHash: player.userHash,
      avatarUrl: this.playerAvatars.get(client.sessionId) || '',
      colors: this.playerColors.get(client.sessionId) || null
    }, { except: client });
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.playerAvatars.delete(client.sessionId);
    this.playerColors.delete(client.sessionId);
    this.playerTextures.delete(client.sessionId);
    console.log(`🚪 [Leave] Player (${client.sessionId}) disconnected.`);

    // プレイヤー退出を全員に通知
    this.broadcast('player_left', { id: client.sessionId });
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
    npc1.x = 0;
    npc1.y = 0.5;
    npc1.z = -4;
    npc1.targetX = 0;
    npc1.targetZ = -4;
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

        // 他プレイヤーへ即座に移動をブロードキャスト
        this.broadcast("player_moved", {
          id: client.sessionId,
          x: player.x,
          y: player.y,
          z: player.z,
          rotationY: player.rotationY
        }, { except: client });
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

    // チャットメッセージ（テキスト & スタンプ）中継
    this.onMessage("chat_message", (client, data: { text: string; senderName?: string; isStamp?: boolean }) => {
      const player = this.state.players.get(client.sessionId);
      const name = data.senderName || player?.name || `Player_${client.sessionId.substring(0, 4)}`;
      const userHash = player?.userHash || '';
      const authType = player?.authType || 'guest';
      this.broadcast("chat_message", {
        sessionId: client.sessionId,
        senderName: name,
        userHash,
        authType,
        text: data.text,
        isStamp: !!data.isStamp,
        timestamp: Date.now()
      });
    });

    // プレイヤー名変更
    this.onMessage("player_rename", (client, data: { name: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (player && data.name) {
        player.name = data.name.trim().substring(0, 20);
        // 名前変更者本人を除いてブロードキャスト（本人への二重登録を防ぐ）
        this.broadcast("player_renamed", { id: client.sessionId, name: player.name }, { except: client });
      }
    });

    // VRM由来の配色情報をブロードキャスト（本人除く全員へ）
    this.onMessage("player_colors", (client, data: { hair: string; skin: string; clothing: string }) => {
      this.playerColors.set(client.sessionId, data);
      this.broadcast("player_colors_broadcast", {
        id: client.sessionId,
        hair: data.hair,
        skin: data.skin,
        clothing: data.clothing
      }, { except: client });
    });

    // VRM由来の顔写真アイコン（サムネイル）を受信しキャッシュ＆ブロードキャスト
    this.onMessage("player_avatar", (client, data: { dataUrl: string }) => {
      if (data && data.dataUrl) {
        this.playerAvatars.set(client.sessionId, data.dataUrl);
        this.broadcast("player_avatar_broadcast", {
          id: client.sessionId,
          dataUrl: data.dataUrl
        }, { except: client });
      }
    });

    // ボックスマン前面テクスチャ（顔・体）を受信しキャッシュ＆ブロードキャスト
    this.onMessage("player_textures", (client, data: { faceDataUrl?: string; bodyDataUrl?: string }) => {
      if (data) {
        this.playerTextures.set(client.sessionId, data);
        this.broadcast("player_textures_broadcast", {
          id: client.sessionId,
          faceDataUrl: data.faceDataUrl,
          bodyDataUrl: data.bodyDataUrl
        }, { except: client });
      }
    });

    // 認証情報検証 & ハッシュ昇格
    this.onMessage("auth_verify", (client, data: { authType: 'github' | 'guest'; githubId?: string; githubUsername?: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      if (data.authType === 'github' && data.githubId) {
        player.authType = 'github';
        player.githubUsername = data.githubUsername || '';
        player.userHash = generateUserHash('gh_' + data.githubId, '#');
      } else {
        player.authType = 'guest';
        player.githubUsername = '';
        const clientIp = (client as any).ref?.remoteAddress || client.sessionId;
        player.userHash = generateUserHash('guest_' + clientIp, '~');
      }
      this.broadcast("player_auth_updated", {
        id: client.sessionId,
        authType: player.authType,
        userHash: player.userHash,
        githubUsername: player.githubUsername
      });
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
        // プレイヤーが暇な時は8秒ごとに新しい見回り地点をゆったり決定
        const patrolStep = Math.floor(now / 8000);
        const wanderX = Math.sin(patrolStep * 1.7) * 4.5;
        const wanderZ = Math.cos(patrolStep * 1.7) * 4.5;
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

      if (dist > 0.1) {
        const speed = 0.08; // 100msあたりの移動量 (秒速0.8mでゆったり移動)
        const step = Math.min(speed, dist);
        npc.x += (dx / dist) * step;
        npc.z += (dz / dist) * step;
      }
    });
  }
}

// ==========================================
// 4. サーバー起動処理
// ==========================================

const port = Number(process.env.PORT || 2567);

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  // CORS ヘッダー
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const host = req.headers.host || `localhost:${port}`;
  const url = new URL(req.url || '/', `http://${host}`);

  // 1. デモ用認証エンドポイント (Client Secret なしでも即座にテスト可能)
  if (url.pathname === '/api/auth/demo') {
    const username = url.searchParams.get('username') || 'GuestUser';
    const rawId = url.searchParams.get('id') || username;
    const userHash = generateUserHash('gh_' + rawId, '#');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      authType: 'github',
      githubUsername: username,
      githubId: rawId,
      userHash
    }));
    return;
  }

  // 2. 本番用 GitHub OAuth 認可リダイレクト (GITHUB_CLIENT_ID が設定されている場合)
  if (url.pathname === '/auth/github') {
    const clientId = process.env.GITHUB_CLIENT_ID;
    if (clientId) {
      const redirectUri = encodeURIComponent(`http://${host}/auth/github/callback`);
      res.writeHead(302, {
        Location: `https://github.com/login/oauth/authorize?client_id=${clientId}&scope=read:user&redirect_uri=${redirectUri}`
      });
      res.end();
      return;
    }

    // Client ID 未設定時の案内
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <html>
        <body style="font-family: sans-serif; background: #0f172a; color: #fff; padding: 40px; text-align: center;">
          <h2>🐱 GitHub OAuth 設定案内</h2>
          <p style="color: #94a3b8;">環境変数 <code>GITHUB_CLIENT_ID</code> が未設定のため、デモ認証をご利用ください。</p>
          <a href="/" style="color: #38bdf8;">ワールドに戻る</a>
        </body>
      </html>
    `);
    return;
  }

  // デフォルトステータス
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('🌲 Voxel Village Game Server is Running.');
});

const gameServer = new Server({
  transport: new WebSocketTransport({
    server: httpServer,
    maxPayload: 10 * 1024 * 1024 // 10MB: テクスチャ画像や大量ボクセル同期に対応
  })
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
