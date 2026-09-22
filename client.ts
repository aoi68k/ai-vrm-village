import * as THREE from 'three';
import { Client, Room } from 'colyseus.js';

// --- クォータービュー カメラシステム ---
export class IsometricCameraSystem {
  public camera: THREE.OrthographicCamera;
  private aspect: number;

  constructor(aspectRatio: number, frustumSize: number = 30) {
    this.aspect = aspectRatio;
    const d = frustumSize;
    this.camera = new THREE.OrthographicCamera(
      -d * this.aspect, d * this.aspect, d, -d, 1, 1000
    );
    // クォータービュー（アイソメトリック）角 45°/35.264°
    this.camera.position.set(100, 100, 100);
    this.camera.lookAt(0, 0, 0);
  }

  public handleResize(width: number, height: number): void {
    this.aspect = width / height;
    const d = 30;
    this.camera.left = -d * this.aspect;
    this.camera.right = d * this.aspect;
    this.camera.top = d;
    this.camera.bottom = -d;
    this.camera.updateProjectionMatrix();
  }
}

// --- レンダラー & ワールド表示 ---
export class VoxelClientApp {
  private scene: THREE.Scene;
  private renderer: THREE.WebGLRenderer;
  private cameraSys: IsometricCameraSystem;
  private instancedMesh!: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();

  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1e1e24);

    const container = document.getElementById('canvas-container')!;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.cameraSys = new IsometricCameraSystem(window.innerWidth / window.innerHeight);

    this.setupLighting();
    this.setupVoxelGrid(20, 20);

    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.cameraSys.handleResize(window.innerWidth, window.innerHeight);
    });

    this.animate();
    
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.innerText = '接続状態: スタンドアロン動作中 (Colyseus接続待機)';
  }

  private setupLighting(): void {
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(50, 80, 30);
    this.scene.add(dirLight);
  }

  private setupVoxelGrid(width: number, depth: number): void {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color: 0x55aa55, roughness: 0.8 });

    const totalCount = width * depth;
    this.instancedMesh = new THREE.InstancedMesh(geometry, material, totalCount);

    let idx = 0;
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < depth; z++) {
        this.dummy.position.set(x - width / 2, 0, z - depth / 2);
        this.dummy.updateMatrix();
        this.instancedMesh.setMatrixAt(idx++, this.dummy.matrix);
      }
    }
    this.instancedMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.instancedMesh);
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.renderer.render(this.scene, this.cameraSys.camera);
  };
}

// アプリケーション起動
new VoxelClientApp();
