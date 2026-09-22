import { Server, Room, Client } from 'colyseus';
import { Schema, type, MapSchema } from '@colyseus/schema';
import { createServer } from 'http';

// --- State Schemas ---
export class VoxelTile extends Schema {
  @type("string") id: string = "";
  @type("number") x: number = 0;
  @type("number") z: number = 0;
  @type("string") type: string = "grass"; // grass, wood, stone
}

export class NPCAgentState extends Schema {
  @type("string") id: string = "";
  @type("string") name: string = "Helper NPC";
  @type("number") x: number = 0;
  @type("number") z: number = 0;
  @type("string") currentTask: string = "Idle";
}

export class GameWorldState extends Schema {
  @type({ map: VoxelTile }) map = new MapSchema<VoxelTile>();
  @type({ map: NPCAgentState }) npcs = new MapSchema<NPCAgentState>();
}

// --- Colyseus Room ---
export class VoxelGameRoom extends Room<GameWorldState> {
  onCreate(options: any) {
    this.setState(new GameWorldState());

    // 初期マップ作成
    for (let x = -10; x <= 10; x++) {
      for (let z = -10; z <= 10; z++) {
        const tile = new VoxelTile();
        tile.id = `${x}_${z}`;
        tile.x = x;
        tile.z = z;
        this.state.map.set(tile.id, tile);
      }
    }

    // 手助けNPC追加
    const npc = new NPCAgentState();
    npc.id = "npc_1";
    npc.name = "Worker Agent";
    npc.x = 0;
    npc.z = 0;
    npc.currentTask = "Assisting Player";
    this.state.npcs.set(npc.id, npc);

    // ボクセル採掘アクションメッセージ受信
    this.onMessage("mine_voxel", (client, data: { id: string }) => {
      if (this.state.map.has(data.id)) {
        this.state.map.delete(data.id);
        console.log(`[VoxelMine] Tile ${data.id} destroyed instantly by player ${client.sessionId}`);
      }
    });

    console.log("[VoxelGameRoom] Created successfully.");
  }

  onJoin(client: Client) {
    console.log(`[Join] Player connected: ${client.sessionId}`);
  }

  onLeave(client: Client) {
    console.log(`[Leave] Player disconnected: ${client.sessionId}`);
  }
}

// --- HTTP & Colyseus Server Initialization ---
const port = Number(process.env.PORT || 2567);
const server = new Server({
  server: createServer()
});

server.define('voxel_room', VoxelGameRoom);

server.listen(port).then(() => {
  console.log(`🚀 Colyseus Authoritative Server running on ws://localhost:${port}`);
});
