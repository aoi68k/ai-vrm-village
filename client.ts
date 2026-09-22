import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { Client, Room } from 'colyseus.js';

// --- 1. クォータービュー（アイソメトリック）カメラシステム ---
export class IsometricCameraSystem {
  public camera: THREE.OrthographicCamera;
  private aspect: number;
  public targetPosition = new THREE.Vector3(0, 0, 0);

  constructor(aspectRatio: number, frustumSize: number = 25) {
    this.aspect = aspectRatio;
    const d = frustumSize;
    this.camera = new THREE.OrthographicCamera(
      -d * this.aspect, d * this.aspect, d, -d, 1, 1000
    );
    // クォータービュー角 (45度回転 / 35.264度見下ろし)
    this.camera.position.set(80, 80, 80);
    this.camera.lookAt(this.targetPosition);
  }

  public updateCameraFollow(targetPos: THREE.Vector3, lerpFactor = 0.08): void {
    this.targetPosition.lerp(targetPos, lerpFactor);
    this.camera.position.set(
      this.targetPosition.x + 80,
      this.targetPosition.y + 80,
      this.targetPosition.z + 80
    );
    this.camera.lookAt(this.targetPosition);
  }

  public handleResize(width: number, height: number): void {
    this.aspect = width / height;
    const d = 25;
    this.camera.left = -d * this.aspect;
    this.camera.right = d * this.aspect;
    this.camera.top = d;
    this.camera.bottom = -d;
    this.camera.updateProjectionMatrix();
  }
}

// --- 2. 強化版 VRM アバター & アニメーションコントローラー ---
export type AvatarState = 'idle' | 'walking' | 'mining' | 'building';

export class VRMAvatarController {
  public vrm: VRM | null = null;
  public position = new THREE.Vector3(0, 0.5, 0);
  public rotationY = 0;
  public currentState: AvatarState = 'idle';

  private moveSpeed = 5.5;
  private walkTime = 0;
  private actionTimer = 0;
  private actionDuration = 0.45; // 採掘・建設モーションの再生時間(秒)
  
  // まばたき制御
  private blinkTimer = 0;
  private isBlinking = false;

  constructor(private scene: THREE.Scene) {}

  public async loadVRMFromUrl(url: string, onProgress?: (percent: number) => void): Promise<VRM | null> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    return new Promise((resolve, reject) => {
      loader.load(
        url,
        (gltf) => {
          const vrm = gltf.userData.vrm as VRM;
          if (!vrm) {
            reject(new Error('VRMデータの解析に失敗しました'));
            return;
          }

          VRMUtils.removeUnnecessaryVertices(gltf.scene);
          VRMUtils.removeUnnecessaryJoints(gltf.scene);

          vrm.scene.traverse((obj) => {
            if ((obj as THREE.Mesh).isMesh) {
              obj.castShadow = true;
              obj.receiveShadow = true;
            }
          });

          if (this.vrm) {
            this.scene.remove(this.vrm.scene);
          }

          this.vrm = vrm;
          this.scene.add(vrm.scene);
          vrm.scene.position.copy(this.position);
          
          console.log('✅ VRMアバターのロード完了:', vrm);
          resolve(vrm);
        },
        (progress) => {
          if (progress.total > 0 && onProgress) {
            onProgress(Math.round((progress.loaded / progress.total) * 100));
          }
        },
        (error) => {
          console.error('❌ VRMロードエラー:', error);
          reject(error);
        }
      );
    });
  }

  // 採掘（スイング）モーション起動
  public triggerMiningAnimation(): void {
    this.currentState = 'mining';
    this.actionTimer = this.actionDuration;
  }

  // 建設（ブロック配置）モーション起動
  public triggerBuildingAnimation(): void {
    this.currentState = 'building';
    this.actionTimer = this.actionDuration;
  }

  public update(delta: number, inputDir: THREE.Vector3, currentGroundY: number = 0.5): void {
    // 高さと接地の更新
    this.position.y = THREE.MathUtils.lerp(this.position.y, currentGroundY, 0.2);

    // 1. 移動・回転の計算
    const isMoving = inputDir.lengthSq() > 0;
    if (isMoving) {
      inputDir.normalize();
      const isoInputDir = new THREE.Vector3(
        (inputDir.x - inputDir.z) * Math.SQRT1_2,
        0,
        (inputDir.x + inputDir.z) * Math.SQRT1_2
      );

      this.position.addScaledVector(isoInputDir, this.moveSpeed * delta);
      
      // 目標回転角度へ滑らかに補正
      const targetRotation = Math.atan2(isoInputDir.x, isoInputDir.z);
      this.rotationY = THREE.MathUtils.lerpAngle(this.rotationY, targetRotation, 0.25);

      if (this.actionTimer <= 0) {
        this.currentState = 'walking';
      }
    } else if (this.actionTimer <= 0) {
      this.currentState = 'idle';
    }

    // アクションタイマー消化
    if (this.actionTimer > 0) {
      this.actionTimer -= delta;
      if (this.actionTimer <= 0) {
        this.currentState = isMoving ? 'walking' : 'idle';
      }
    }

    // 2. VRM モデル姿勢と手続き型関節骨格（Humanoid Bone）アニメーション制御
    if (this.vrm) {
      this.vrm.scene.position.copy(this.position);
      this.vrm.scene.rotation.y = this.rotationY;

      this.animateHumanoidBones(delta, isMoving);
      this.animateExpressions(delta);

      // 揺れもの（Spring Bone）物理演算の更新
      this.vrm.update(delta);
    }
  }

  private animateHumanoidBones(delta: number, isMoving: boolean): void {
    if (!this.vrm?.humanoid) return;

    const humanoid = this.vrm.humanoid;
    const spine = humanoid.getNormalizedBoneNode('spine');
    const chest = humanoid.getNormalizedBoneNode('chest');
    const head = humanoid.getNormalizedBoneNode('head');

    const leftUpperLeg = humanoid.getNormalizedBoneNode('leftUpperLeg');
    const rightUpperLeg = humanoid.getNormalizedBoneNode('rightUpperLeg');
    const leftLowerLeg = humanoid.getNormalizedBoneNode('leftLowerLeg');
    const rightLowerLeg = humanoid.getNormalizedBoneNode('rightLowerLeg');

    const leftUpperArm = humanoid.getNormalizedBoneNode('leftUpperArm');
    const rightUpperArm = humanoid.getNormalizedBoneNode('rightUpperArm');
    const leftLowerArm = humanoid.getNormalizedBoneNode('leftLowerArm');
    const rightLowerArm = humanoid.getNormalizedBoneNode('rightLowerArm');

    // --- A. 採掘（ツルハシ・斧振るい）モーション ---
    if (this.currentState === 'mining') {
      const progress = 1.0 - Math.max(0, this.actionTimer / this.actionDuration);
      const swingAngle = Math.sin(progress * Math.PI) * 1.6;

      if (chest) chest.rotation.x = 0.3 * Math.sin(progress * Math.PI);
      if (rightUpperArm) {
        rightUpperArm.rotation.x = -0.5 + swingAngle;
        rightUpperArm.rotation.z = -0.3;
      }
      if (rightLowerArm) rightLowerArm.rotation.x = -0.8 + swingAngle * 0.5;
      if (leftUpperArm) {
        leftUpperArm.rotation.x = 0.2;
        leftUpperArm.rotation.z = 0.4;
      }
      return;
    }

    // --- B. 建設（設置構え）モーション ---
    if (this.currentState === 'building') {
      const progress = 1.0 - Math.max(0, this.actionTimer / this.actionDuration);
      const pushFactor = Math.sin(progress * Math.PI);

      if (chest) chest.rotation.x = -0.1 * pushFactor;
      if (rightUpperArm) {
        rightUpperArm.rotation.x = -0.8 * pushFactor;
        rightUpperArm.rotation.z = -0.2;
      }
      if (leftUpperArm) {
        leftUpperArm.rotation.x = -0.8 * pushFactor;
        leftUpperArm.rotation.z = 0.2;
      }
      if (rightLowerArm) rightLowerArm.rotation.x = -0.4 * pushFactor;
      if (leftLowerArm) leftLowerArm.rotation.x = -0.4 * pushFactor;
      return;
    }

    // --- C. 歩行 ＆ 待機モーション（リアルな重心移動・関節連動） ---
    if (isMoving) {
      this.walkTime += delta * 11.0;

      // 1. 脚のスイング ＆ 膝の屈伸
      const legAngle = Math.sin(this.walkTime) * 0.55;
      if (leftUpperLeg) leftUpperLeg.rotation.x = legAngle;
      if (rightUpperLeg) rightUpperLeg.rotation.x = -legAngle;

      // 後ろに下がる脚の膝を自然に曲げる
      if (leftLowerLeg) leftLowerLeg.rotation.x = legAngle < 0 ? Math.abs(legAngle) * 0.8 : 0.05;
      if (rightLowerLeg) rightLowerLeg.rotation.x = legAngle > 0 ? Math.abs(legAngle) * 0.8 : 0.05;

      // 2. 腕の反対スイング ＆ 肘の微曲がり
      const armAngle = Math.sin(this.walkTime) * 0.45;
      if (leftUpperArm) {
        leftUpperArm.rotation.x = -armAngle;
        leftUpperArm.rotation.z = 0.25;
      }
      if (rightUpperArm) {
        rightUpperArm.rotation.x = armAngle;
        rightUpperArm.rotation.z = -0.25;
      }
      if (leftLowerArm) leftLowerArm.rotation.x = -0.25;
      if (rightLowerArm) rightLowerArm.rotation.x = -0.25;

      // 3. 上半身の上下スイング（歩行の跳ね）＆ 脊椎の微ねじれ
      if (spine) {
        spine.position.y = Math.abs(Math.sin(this.walkTime * 2)) * 0.04;
        spine.rotation.y = -legAngle * 0.15;
      }
      if (head) head.rotation.y = legAngle * 0.08; // 視線スタビライザー
    } else {
      // 待機時のゆっくりとした呼吸（Breathing）モーション
      this.walkTime += delta * 2.0;
      const breath = Math.sin(this.walkTime) * 0.03;

      if (spine) {
        spine.position.y = THREE.MathUtils.lerp(spine.position.y, 0, 0.1);
        spine.rotation.y = THREE.MathUtils.lerp(spine.rotation.y, 0, 0.1);
      }
      if (chest) chest.rotation.x = breath;
      if (head) head.rotation.x = -breath * 0.5;

      // 姿勢の初期化復元
      const lerpSpeed = 0.15;
      if (leftUpperLeg) leftUpperLeg.rotation.x = THREE.MathUtils.lerp(leftUpperLeg.rotation.x, 0, lerpSpeed);
      if (rightUpperLeg) rightUpperLeg.rotation.x = THREE.MathUtils.lerp(rightUpperLeg.rotation.x, 0, lerpSpeed);
      if (leftLowerLeg) leftLowerLeg.rotation.x = THREE.MathUtils.lerp(leftLowerLeg.rotation.x, 0, lerpSpeed);
      if (rightLowerLeg) rightLowerLeg.rotation.x = THREE.MathUtils.lerp(rightLowerLeg.rotation.x, 0, lerpSpeed);

      if (leftUpperArm) {
        leftUpperArm.rotation.x = THREE.MathUtils.lerp(leftUpperArm.rotation.x, 0, lerpSpeed);
        leftUpperArm.rotation.z = THREE.MathUtils.lerp(leftUpperArm.rotation.z, 0.2, lerpSpeed);
      }
      if (rightUpperArm) {
        rightUpperArm.rotation.x = THREE.MathUtils.lerp(rightUpperArm.rotation.x, 0, lerpSpeed);
        rightUpperArm.rotation.z = THREE.MathUtils.lerp(rightUpperArm.rotation.z, -0.2, lerpSpeed);
      }
    }
  }

  private animateExpressions(delta: number): void {
    if (!this.vrm?.expressionManager) return;

    // 自動まばたきシステム
    this.blinkTimer += delta;
    if (this.blinkTimer > 3.5) {
      this.isBlinking = true;
      this.blinkTimer = 0;
    }

    if (this.isBlinking) {
      const blinkVal = Math.sin(this.blinkTimer * Math.PI * 8);
      if (blinkVal < 0) {
        this.isBlinking = false;
        this.vrm.expressionManager.setValue('blink', 0);
      } else {
        this.vrm.expressionManager.setValue('blink', blinkVal);
      }
    }
  }
}

// --- 3. 動的ボクセルワールド (レイキャスト & インスタンス描画) ---
export type VoxelType = 'grass' | 'dirt' | 'stone' | 'wood' | 'plank';

export interface VoxelBlock {
  x: number;
  y: number;
  z: number;
  type: VoxelType;
}

export class DynamicVoxelWorld {
  private voxelMap = new Map<string, VoxelType>();
  private meshMap = new Map<VoxelType, THREE.InstancedMesh>();
  private dummy = new THREE.Object3D();

  private materials: Record<VoxelType, THREE.MeshStandardMaterial> = {
    grass: new THREE.MeshStandardMaterial({ color: 0x55aa44, roughness: 0.8 }),
    dirt: new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.9 }),
    stone: new THREE.MeshStandardMaterial({ color: 0x777788, roughness: 0.6 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 0.7 }),
    plank: new THREE.MeshStandardMaterial({ color: 0xc4a482, roughness: 0.5 })
  };

  constructor(private scene: THREE.Scene, private worldSize: number = 24) {
    this.initWorldData();
    this.createInstancedMeshes();
  }

  private initWorldData(): void {
    // 平地 + 起伏 + ボクセルの木々
    for (let x = -this.worldSize / 2; x <= this.worldSize / 2; x++) {
      for (let z = -this.worldSize / 2; z <= this.worldSize / 2; z++) {
        const key = `${x},0,${z}`;
        this.voxelMap.set(key, 'grass');

        // 中央近くに起伏の丘
        if (Math.hypot(x, z) < 6) {
          this.voxelMap.set(`${x},1,${z}`, 'dirt');
        }
      }
    }

    // ボクセルの木々を複数配置
    const trees = [[-5, -5], [6, 6], [-7, 5], [5, -6]];
    trees.forEach(([tx, tz]) => {
      for (let h = 1; h <= 3; h++) {
        this.voxelMap.set(`${tx},${h},${tz}`, 'wood');
      }
      for (let lx = tx - 1; lx <= tx + 1; lx++) {
        for (let lz = tz - 1; lz <= tz + 1; lz++) {
          this.voxelMap.set(`${lx},4,${lz}`, 'grass');
        }
      }
    });
  }

  private createInstancedMeshes(): void {
    const geometry = new THREE.BoxGeometry(0.98, 0.98, 0.98);

    (Object.keys(this.materials) as VoxelType[]).forEach((type) => {
      const mesh = new THREE.InstancedMesh(geometry, this.materials[type], 1000);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.meshMap.set(type, mesh);
      this.scene.add(mesh);
    });

    this.rebuildMeshes();
  }

  public rebuildMeshes(): void {
    const counts: Record<VoxelType, number> = { grass: 0, dirt: 0, stone: 0, wood: 0, plank: 0 };

    this.voxelMap.forEach((type, key) => {
      const [x, y, z] = key.split(',').map(Number);
      const mesh = this.meshMap.get(type);
      if (mesh) {
        const idx = counts[type]++;
        this.dummy.position.set(x, y, z);
        this.dummy.updateMatrix();
        mesh.setMatrixAt(idx, this.dummy.matrix);
      }
    });

    this.meshMap.forEach((mesh, type) => {
      mesh.count = counts[type];
      mesh.instanceMatrix.needsUpdate = true;
    });
  }

  public getGroundHeight(x: number, z: number): number {
    const rx = Math.round(x);
    const rz = Math.round(z);
    for (let y = 10; y >= 0; y--) {
      if (this.voxelMap.has(`${rx},${y},${rz}`)) {
        return y + 0.5;
      }
    }
    return 0.5;
  }

  public removeVoxel(x: number, y: number, z: number): boolean {
    const key = `${x},${y},${z}`;
    if (this.voxelMap.has(key)) {
      this.voxelMap.delete(key);
      this.rebuildMeshes();
      return true;
    }
    return false;
  }

  public addVoxel(x: number, y: number, z: number, type: VoxelType): boolean {
    const key = `${x},${y},${z}`;
    if (!this.voxelMap.has(key)) {
      this.voxelMap.set(key, type);
      this.rebuildMeshes();
      return true;
    }
    return false;
  }

  public getInstancedMeshes(): THREE.InstancedMesh[] {
    return Array.from(this.meshMap.values());
  }
}

// --- 4. Colyseus ネットワーク同期コントローラー ---
export class NetworkController {
  private client: Client;
  public room: Room | null = null;
  public isConnected = false;

  constructor(serverUrl: string = 'ws://localhost:2567') {
    this.client = new Client(serverUrl);
  }

  public async connect(onStatusChange?: (msg: string) => void): Promise<boolean> {
    try {
      if (onStatusChange) onStatusChange('Colyseus サーバーへ接続中...');
      this.room = await this.client.joinOrCreate('voxel_room');
      this.isConnected = true;
      if (onStatusChange) onStatusChange('🟢 オンライン (Colyseus同期中)');
      console.log('✅ Colyseus ルーム参加完了:', this.room.id);
      return true;
    } catch (e) {
      this.isConnected = false;
      if (onStatusChange) onStatusChange('🟡 オフライン (スタンドアロン動作中)');
      console.warn('⚠️ Colyseus サーバー非接続。スタンドアロンモードで起動します。');
      return false;
    }
  }

  public sendPlayerMove(x: number, z: number, rotY: number): void {
    if (this.isConnected && this.room) {
      this.room.send('player_move', { x, z, rotY });
    }
  }

  public sendPlayerAction(actionType: 'mine' | 'build', x: number, y: number, z: number): void {
    if (this.isConnected && this.room) {
      this.room.send('player_action', { actionType, x, y, z });
    }
  }

  public sendDestroyVoxel(x: number, y: number, z: number): void {
    if (this.isConnected && this.room) {
      this.room.send('destroy_voxel', { x, y, z });
    }
  }

  public sendPlaceVoxel(x: number, y: number, z: number, type: string): void {
    if (this.isConnected && this.room) {
      this.room.send('place_voxel', { x, y, z, type });
    }
  }
}

// --- 5. メインアプリケーション統合 ---
export class VoxelVRMApp {
  private scene: THREE.Scene;
  private renderer: THREE.WebGLRenderer;
  private cameraSys: IsometricCameraSystem;
  private avatar: VRMAvatarController;
  private world: DynamicVoxelWorld;
  private network: NetworkController;
  private clock = new THREE.Clock();

  // レイキャスト & カーソル表示
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private cursorMesh: THREE.LineSegments;
  private selectedVoxelType: VoxelType = 'plank';

  // キー状態
  private keys: { [key: string]: boolean } = {};
  private selectedTarget: { x: number; y: number; z: number; normal: THREE.Vector3 } | null = null;

  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);

    const container = document.getElementById('canvas-container')!;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.cameraSys = new IsometricCameraSystem(window.innerWidth / window.innerHeight);
    this.avatar = new VRMAvatarController(this.scene);
    this.world = new DynamicVoxelWorld(this.scene);
    this.network = new NetworkController();

    // ホバー選択枠（ワイヤーフレームカーソル）
    const boxGeo = new THREE.BoxGeometry(1.02, 1.02, 1.02);
    const wireGeo = new THREE.WireframeGeometry(boxGeo);
    this.cursorMesh = new THREE.LineSegments(
      wireGeo,
      new THREE.LineBasicMaterial({ color: 0xffea00, linewidth: 2 })
    );
    this.cursorMesh.visible = false;
    this.scene.add(this.cursorMesh);

    this.setupLighting();
    this.setupInputListeners();
    this.setupDragAndDrop();

    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.cameraSys.handleResize(window.innerWidth, window.innerHeight);
    });

    // 初期起動
    this.initApp();
  }

  private async initApp(): Promise<void> {
    await this.network.connect((status) => this.updateStatus(status));

    // サンプルVRMモデルのロード
    const sampleVrmUrl = 'https://pixiv.github.io/three-vrm/packages/three-vrm/examples/models/VRM1_Constraint_Sample.vrm';
    try {
      await this.avatar.loadVRMFromUrl(sampleVrmUrl);
      this.updateStatus('🟢 準備完了: WASDで移動 / 左クリックで採掘 / 右クリックで設置');
    } catch {
      this.updateStatus('🟡 VRM待機中: 手元の .vrm ファイルを画面へドラッグ＆ドロップしてください');
    }

    this.animate();
  }

  private setupLighting(): void {
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xfffaed, 1.2);
    dirLight.position.set(40, 60, 30);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    this.scene.add(dirLight);
  }

  private setupInputListeners(): void {
    window.addEventListener('keydown', (e) => {
      this.keys[e.key.toLowerCase()] = true;
      if (['1', '2', '3', '4', '5'].includes(e.key)) {
        const types: VoxelType[] = ['plank', 'wood', 'stone', 'dirt', 'grass'];
        this.selectedVoxelType = types[parseInt(e.key) - 1];
        this.updateUIOverlay();
      }
    });

    window.addEventListener('keyup', (e) => (this.keys[e.key.toLowerCase()] = false));

    window.addEventListener('mousemove', (e) => {
      this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    });

    window.addEventListener('mousedown', (e) => {
      if (!this.selectedTarget) return;

      const { x, y, z, normal } = this.selectedTarget;

      if (e.button === 0) {
        // 左クリック: 採掘・破壊
        if (this.world.removeVoxel(x, y, z)) {
          this.avatar.triggerMiningAnimation(); // 腕振るいモーション発火
          this.network.sendDestroyVoxel(x, y, z);
          this.network.sendPlayerAction('mine', x, y, z);
        }
      } else if (e.button === 2) {
        // 右クリック: 建設・配置
        const nx = x + normal.x;
        const ny = y + normal.y;
        const nz = z + normal.z;

        if (this.world.addVoxel(nx, ny, nz, this.selectedVoxelType)) {
          this.avatar.triggerBuildingAnimation(); // 設置構えモーション発火
          this.network.sendPlaceVoxel(nx, ny, nz, this.selectedVoxelType);
          this.network.sendPlayerAction('build', nx, ny, nz);
        }
      }
    });

    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private setupDragAndDrop(): void {
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (files && files.length > 0 && files[0].name.endsWith('.vrm')) {
        const blobUrl = URL.createObjectURL(files[0]);
        this.avatar.loadVRMFromUrl(blobUrl);
      }
    });
  }

  private updateRaycastHover(): void {
    this.raycaster.setFromCamera(this.mouse, this.cameraSys.camera);
    const intersects = this.raycaster.intersectObjects(this.world.getInstancedMeshes());

    if (intersects.length > 0) {
      const hit = intersects[0];
      if (hit.instanceId !== undefined && hit.face) {
        const matrix = new THREE.Matrix4();
        (hit.object as THREE.InstancedMesh).getMatrixAt(hit.instanceId, matrix);
        const pos = new THREE.Vector3().setFromMatrixPosition(matrix);

        this.selectedTarget = {
          x: Math.round(pos.x),
          y: Math.round(pos.y),
          z: Math.round(pos.z),
          normal: hit.face.normal.clone()
        };

        this.cursorMesh.position.set(pos.x, pos.y, pos.z);
        this.cursorMesh.visible = true;
        return;
      }
    }

    this.selectedTarget = null;
    this.cursorMesh.visible = false;
  }

  private updateUIOverlay(): void {
    const el = document.getElementById('ui-overlay');
    if (el) {
      el.innerHTML = `
        <b>選択ブロック:</b> ${this.selectedVoxelType.toUpperCase()} (数字キー1-5で切替)<br/>
        <b>操作:</b> WASDで移動 / 左クリックで採掘 / 右クリックで配置
      `;
    }
  }

  private updateStatus(msg: string): void {
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.innerText = msg;
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);

    const delta = Math.min(this.clock.getDelta(), 0.1);

    // WASD 入力ベクトル
    const inputDir = new THREE.Vector3(0, 0, 0);
    if (this.keys['w'] || this.keys['arrowup']) inputDir.z -= 1;
    if (this.keys['s'] || this.keys['arrowdown']) inputDir.z += 1;
    if (this.keys['a'] || this.keys['arrowleft']) inputDir.x -= 1;
    if (this.keys['d'] || this.keys['arrowright']) inputDir.x += 1;

    // 現在足元の地形高度を取得してアバターを更新
    const groundY = this.world.getGroundHeight(this.avatar.position.x, this.avatar.position.z);
    this.avatar.update(delta, inputDir, groundY);

    // ネットワーク位置送信
    if (inputDir.lengthSq() > 0) {
      this.network.sendPlayerMove(this.avatar.position.x, this.avatar.position.z, this.avatar.rotationY);
    }

    // マウスホバー & Raycast 更新
    this.updateRaycastHover();

    // アイソメトリックカメラ追従
    this.cameraSys.updateCameraFollow(this.avatar.position);

    this.renderer.render(this.scene, this.cameraSys.camera);
  };
}

// アプリケーション起動
new VoxelVRMApp();
