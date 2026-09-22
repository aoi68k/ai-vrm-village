import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { Client, Room } from 'colyseus.js';

// 角度の最短方向 Lerp 補間ヘルパー
export function lerpAngle(current: number, target: number, t: number): number {
  let diff = (target - current) % (Math.PI * 2);
  if (diff < -Math.PI) diff += Math.PI * 2;
  if (diff > Math.PI) diff -= Math.PI * 2;
  return current + diff * t;
}

// ============================================================================
// 1. クォータービュー（アイソメトリック）カメラシステム
// ============================================================================
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

// ============================================================================
// 2. VRM アバター & 精密手続き型アニメーションコントローラー (自プレイヤー専用)
// ============================================================================
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
      this.rotationY = lerpAngle(this.rotationY, targetRotation, 0.25);

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

// ============================================================================
// 3. Web Audio API によるシンセサイズ効果音マネージャー (外部依存ゼロ)
// ============================================================================
export class SoundManager {
  private ctx: AudioContext | null = null;

  private initCtx(): void {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  // 採掘・ブロック破壊音 (インパクト + ノイズ崩壊)
  public playMine(): void {
    this.initCtx();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    // 低音インパクト
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.12);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.12);

    // ザクッとした崩壊ノイズ
    const bufferSize = this.ctx.sampleRate * 0.08;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.3));
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.2, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    noise.connect(noiseGain);
    noiseGain.connect(this.ctx.destination);
    noise.start(now);
  }

  // ブロック設置音 (ポンッという心地よい木質トーン)
  public playPlace(): void {
    this.initCtx();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(260, now);
    osc.frequency.exponentialRampToValueAtTime(420, now + 0.06);
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.09);
  }

  // ブロックパレット切替音 (短いクリック音)
  public playSelect(): void {
    this.initCtx();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(800, now);
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.03);
  }

  // NPC呼びかけ・セリフ更新通知音 (ピロリン音)
  public playNotice(): void {
    this.initCtx();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    [0, 0.08].forEach((offset, idx) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(idx === 0 ? 523.25 : 783.99, now + offset); // C5 -> G5
      gain.gain.setValueAtTime(0.12, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.15);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.15);
    });
  }
}

// ============================================================================
// 4. 採掘パーティクル演出システム (VFX)
// ============================================================================
interface Particle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
}

export class VoxelParticleSystem {
  private particles: Particle[] = [];
  private geo = new THREE.BoxGeometry(0.16, 0.16, 0.16);

  constructor(private scene: THREE.Scene) {}

  public spawnExplosion(x: number, y: number, z: number, color: THREE.Color, count = 12): void {
    const mat = new THREE.MeshBasicMaterial({ color });

    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.position.set(
        x + (Math.random() - 0.5) * 0.6,
        y + (Math.random() - 0.5) * 0.6,
        z + (Math.random() - 0.5) * 0.6
      );
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);

      const velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 4.5,
        Math.random() * 4.0 + 1.5,
        (Math.random() - 0.5) * 4.5
      );

      this.scene.add(mesh);
      this.particles.push({
        mesh,
        velocity,
        life: 0,
        maxLife: 0.45 + Math.random() * 0.25
      });
    }
  }

  public update(delta: number): void {
    const gravity = -9.8;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += delta;

      if (p.life >= p.maxLife) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        this.particles.splice(i, 1);
        continue;
      }

      // 重力と速度の適用
      p.velocity.y += gravity * delta;
      p.mesh.position.addScaledVector(p.velocity, delta);

      // 時間経過で縮小
      const scale = 1.0 - p.life / p.maxLife;
      p.mesh.scale.set(scale, scale, scale);
    }
  }
}

// ============================================================================
// 5. 他プレイヤー (Remote Player) 軽量プロシージャルレンダラー
// ============================================================================
export class RemotePlayerRenderer {
  public group = new THREE.Group();
  public targetPos = new THREE.Vector3();
  public targetRotY = 0;
  private walkTime = 0;
  private leftArm: THREE.Mesh;
  private rightArm: THREE.Mesh;
  private body: THREE.Mesh;

  constructor(public id: string, name: string) {
    // 愛らしいボクセル風キャラクター
    const bodyGeo = new THREE.BoxGeometry(0.5, 0.7, 0.35);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3b82f6 }); // 青系服
    this.body = new THREE.Mesh(bodyGeo, bodyMat);
    this.body.position.y = 0.5;
    this.group.add(this.body);

    const headGeo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
    const headMat = new THREE.MeshStandardMaterial({ color: 0xfde047 }); // 頭部
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 1.05;
    this.group.add(head);

    const armGeo = new THREE.BoxGeometry(0.15, 0.5, 0.15);
    const armMat = new THREE.MeshStandardMaterial({ color: 0x60a5fa });

    this.leftArm = new THREE.Mesh(armGeo, armMat);
    this.leftArm.position.set(-0.35, 0.5, 0);
    this.group.add(this.leftArm);

    this.rightArm = new THREE.Mesh(armGeo, armMat);
    this.rightArm.position.set(0.35, 0.5, 0);
    this.group.add(this.rightArm);

    // ネームプレート (Canvas Texture)
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.roundRect(10, 10, 236, 44, 10);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, 128, 32);
    }
    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: texture });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.position.set(0, 1.5, 0);
    sprite.scale.set(1.5, 0.38, 1);
    this.group.add(sprite);
  }

  public update(delta: number): void {
    this.group.position.lerp(this.targetPos, 0.2);
    this.group.rotation.y = lerpAngle(this.group.rotation.y, this.targetRotY, 0.2);

    const isMoving = this.group.position.distanceTo(this.targetPos) > 0.05;
    if (isMoving) {
      this.walkTime += delta * 10;
      const angle = Math.sin(this.walkTime) * 0.6;
      this.leftArm.rotation.x = angle;
      this.rightArm.rotation.x = -angle;
      this.body.position.y = 0.5 + Math.abs(Math.sin(this.walkTime * 2)) * 0.05;
    } else {
      this.leftArm.rotation.x = 0;
      this.rightArm.rotation.x = 0;
      this.body.position.y = 0.5;
    }
  }
}

// ============================================================================
// 6. GOAP 自律型手助けNPC (お手伝いピコ) 3Dレンダラー
// ============================================================================
export class NPCRenderer {
  public group = new THREE.Group();
  public targetPos = new THREE.Vector3(2, 0.5, 2);
  private walkTime = 0;
  private speechSprite: THREE.Sprite;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private currentMsg = '';

  constructor(public name: string = 'お手伝いピコ') {
    // 愛情深いマスコットロボット風デザイン
    const bodyGeo = new THREE.BoxGeometry(0.55, 0.6, 0.45);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.4 }); // ライトブルー
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.45;
    this.group.add(body);

    const headGeo = new THREE.BoxGeometry(0.48, 0.45, 0.45);
    const headMat = new THREE.MeshStandardMaterial({ color: 0xf0f9ff, roughness: 0.3 }); // 白い顔
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 0.95;
    this.group.add(head);

    // アンテナ
    const antGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.3);
    const antMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b });
    const ant = new THREE.Mesh(antGeo, antMat);
    ant.position.y = 1.3;
    this.group.add(ant);

    // 頭上ビルボード会話吹き出し
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 128;
    this.ctx = this.canvas.getContext('2d');

    const texture = new THREE.CanvasTexture(this.canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: texture });
    this.speechSprite = new THREE.Sprite(spriteMat);
    this.speechSprite.position.set(0, 1.8, 0);
    this.speechSprite.scale.set(2.4, 0.6, 1);
    this.group.add(this.speechSprite);

    this.updateSpeechBubble('こんにちは！');
  }

  public updateSpeechBubble(msg: string): void {
    if (this.currentMsg === msg || !this.ctx) return;
    this.currentMsg = msg;

    this.ctx.clearRect(0, 0, 512, 128);

    // 吹き出し背景
    this.ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    this.ctx.strokeStyle = '#38bdf8';
    this.ctx.lineWidth = 4;
    this.ctx.roundRect(16, 16, 480, 96, 20);
    this.ctx.fill();
    this.ctx.stroke();

    // NPC名とメッセージ
    this.ctx.fillStyle = '#38bdf8';
    this.ctx.font = 'bold 22px sans-serif';
    this.ctx.fillText(`🤖 ${this.name}`, 36, 46);

    this.ctx.fillStyle = '#ffffff';
    this.ctx.font = '20px sans-serif';
    const trimmed = msg.length > 22 ? msg.substring(0, 22) + '...' : msg;
    this.ctx.fillText(trimmed, 36, 82);

    this.speechSprite.material.map!.needsUpdate = true;
  }

  public update(delta: number): void {
    const dist = this.group.position.distanceTo(this.targetPos);
    if (dist > 0.05) {
      this.group.position.lerp(this.targetPos, 0.15);

      // 移動方向を向く
      const dx = this.targetPos.x - this.group.position.x;
      const dz = this.targetPos.z - this.group.position.z;
      if (Math.hypot(dx, dz) > 0.01) {
        const targetAngle = Math.atan2(dx, dz);
        this.group.rotation.y = lerpAngle(this.group.rotation.y, targetAngle, 0.2);
      }

      // ちょこちょこ歩くバウンド
      this.walkTime += delta * 12;
      this.group.position.y = 0.5 + Math.abs(Math.sin(this.walkTime)) * 0.12;
    } else {
      this.group.position.y = 0.5;
    }
  }
}

// ============================================================================
// 7. 動的ボクセルワールド (6種対応・InstancedMesh高速描画)
// ============================================================================
export type VoxelType = 'grass' | 'dirt' | 'stone' | 'wood' | 'leaves' | 'plank';

export class DynamicVoxelWorld {
  public voxelMap = new Map<string, VoxelType>();
  private meshMap = new Map<VoxelType, THREE.InstancedMesh>();
  private dummy = new THREE.Object3D();

  private materials: Record<VoxelType, THREE.MeshStandardMaterial> = {
    grass: new THREE.MeshStandardMaterial({ color: 0x55aa44, roughness: 0.8 }),
    dirt: new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.9 }),
    stone: new THREE.MeshStandardMaterial({ color: 0x777788, roughness: 0.6 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 0.7 }),
    leaves: new THREE.MeshStandardMaterial({ color: 0x3e8e41, roughness: 0.8 }),
    plank: new THREE.MeshStandardMaterial({ color: 0xc4a482, roughness: 0.5 })
  };

  constructor(private scene: THREE.Scene, private worldSize: number = 24) {
    this.initWorldData();
    this.createInstancedMeshes();
  }

  private initWorldData(): void {
    // ローカルワールド先行生成 (ソロ・オフライン完全動作の担保)
    for (let x = -this.worldSize / 2; x <= this.worldSize / 2; x++) {
      for (let z = -this.worldSize / 2; z <= this.worldSize / 2; z++) {
        const key = `${x},0,${z}`;
        this.voxelMap.set(key, 'grass');

        // 起伏の丘
        if (Math.hypot(x, z) < 6) {
          this.voxelMap.set(`${x},1,${z}`, 'dirt');
        }
      }
    }

    // 木々 (原木 + 葉冠)
    const trees = [[-5, -5], [6, 6], [-7, 5], [5, -6]];
    trees.forEach(([tx, tz]) => {
      for (let h = 1; h <= 3; h++) {
        this.voxelMap.set(`${tx},${h},${tz}`, 'wood');
      }
      for (let lx = tx - 1; lx <= tx + 1; lx++) {
        for (let lz = tz - 1; lz <= tz + 1; lz++) {
          this.voxelMap.set(`${lx},4,${lz}`, 'leaves');
        }
      }
    });
  }

  private createInstancedMeshes(): void {
    const geometry = new THREE.BoxGeometry(0.98, 0.98, 0.98);

    (Object.keys(this.materials) as VoxelType[]).forEach((type) => {
      const mesh = new THREE.InstancedMesh(geometry, this.materials[type], 2500);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.meshMap.set(type, mesh);
      this.scene.add(mesh);
    });

    this.rebuildMeshes();
  }

  public rebuildMeshes(): void {
    const counts: Record<VoxelType, number> = {
      grass: 0, dirt: 0, stone: 0, wood: 0, leaves: 0, plank: 0
    };

    this.voxelMap.forEach((type, key) => {
      const [x, y, z] = key.split(',').map(Number);
      const mesh = this.meshMap.get(type);
      if (mesh && counts[type] < 2500) {
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

  public getVoxelType(x: number, y: number, z: number): VoxelType | undefined {
    return this.voxelMap.get(`${x},${y},${z}`);
  }

  public getVoxelColor(type: VoxelType): THREE.Color {
    const mat = this.materials[type];
    return mat ? mat.color : new THREE.Color(0x888888);
  }

  // 採掘・削除 (即時Optimistic)
  public removeVoxel(x: number, y: number, z: number): boolean {
    const key = `${x},${y},${z}`;
    if (this.voxelMap.has(key)) {
      this.voxelMap.delete(key);
      this.rebuildMeshes();
      return true;
    }
    return false;
  }

  // 配置・追加 (即時Optimistic)
  public addVoxel(x: number, y: number, z: number, type: VoxelType): boolean {
    const key = `${x},${y},${z}`;
    if (!this.voxelMap.has(key)) {
      this.voxelMap.set(key, type);
      this.rebuildMeshes();
      return true;
    }
    return false;
  }

  // サーバー初期同期用 (バッチ取り込み)
  public batchMerge(voxels: Array<{ x: number; y: number; z: number; type: VoxelType }>): void {
    voxels.forEach((v) => {
      this.voxelMap.set(`${v.x},${v.y},${v.z}`, v.type);
    });
    this.rebuildMeshes();
  }

  public getInstancedMeshes(): THREE.InstancedMesh[] {
    return Array.from(this.meshMap.values());
  }
}

// ============================================================================
// 8. Colyseus ネットワーク同期コントローラー (リアルタイム双方向同期)
// ============================================================================
export class NetworkController {
  private client: Client;
  public room: Room | null = null;
  public isConnected = false;

  constructor(serverUrl: string = 'ws://localhost:2567') {
    this.client = new Client(serverUrl);
  }

  public async connect(
    onStatusChange: (msg: string, isOnline: boolean) => void,
    onVoxelAdd: (x: number, y: number, z: number, type: VoxelType, isRemote: boolean) => void,
    onVoxelRemove: (x: number, y: number, z: number, isRemote: boolean) => void,
    onPlayerJoin: (id: string, name: string, x: number, y: number, z: number) => void,
    onPlayerLeave: (id: string) => void,
    onPlayerMove: (id: string, x: number, y: number, z: number, rotY: number) => void,
    onNPCUpdate: (npc: { id: string; name: string; x: number; y: number; z: number; targetX: number; targetZ: number; goal: string; task: string; message: string }) => void
  ): Promise<boolean> {
    try {
      onStatusChange('Colyseus サーバーへ接続中...', false);
      this.room = await this.client.joinOrCreate('voxel_room');
      this.isConnected = true;
      onStatusChange(`🟢 ONLINE (${this.room.id})`, true);
      console.log('✅ Colyseus ルーム参加完了:', this.room.id);

      // --- A. ボクセル同期 ---
      this.room.state.voxels.onAdd = (voxel: { x: number; y: number; z: number; type: string }) => {
        onVoxelAdd(voxel.x, voxel.y, voxel.z, (voxel.type as VoxelType) || 'dirt', true);
      };

      this.room.state.voxels.onRemove = (voxel: { x: number; y: number; z: number }) => {
        onVoxelRemove(voxel.x, voxel.y, voxel.z, true);
      };

      // --- B. プレイヤー同期 ---
      this.room.state.players.onAdd = (player: { id: string; name: string; x: number; y: number; z: number; rotationY: number }, sessionId: string) => {
        if (sessionId !== this.room?.sessionId) {
          onPlayerJoin(sessionId, player.name || `Player_${sessionId.substring(0, 4)}`, player.x, player.y, player.z);
        }
      };

      this.room.state.players.onRemove = (_player: unknown, sessionId: string) => {
        if (sessionId !== this.room?.sessionId) {
          onPlayerLeave(sessionId);
        }
      };

      this.room.state.players.onChange = (player: { x: number; y: number; z: number; rotationY: number }, sessionId: string) => {
        if (sessionId !== this.room?.sessionId) {
          onPlayerMove(sessionId, player.x, player.y, player.z, player.rotationY || 0);
        }
      };

      // --- C. GOAP NPC同期 ---
      this.room.state.npcs.onAdd = (npc: { id: string; name: string; x: number; y: number; z: number; targetX: number; targetZ: number; currentGoal: string; currentTask: string; statusMessage: string }) => {
        onNPCUpdate({
          id: npc.id,
          name: npc.name,
          x: npc.x,
          y: npc.y,
          z: npc.z,
          targetX: npc.targetX,
          targetZ: npc.targetZ,
          goal: npc.currentGoal,
          task: npc.currentTask,
          message: npc.statusMessage
        });
      };

      this.room.state.npcs.onChange = (npc: { id: string; name: string; x: number; y: number; z: number; targetX: number; targetZ: number; currentGoal: string; currentTask: string; statusMessage: string }) => {
        onNPCUpdate({
          id: npc.id,
          name: npc.name,
          x: npc.x,
          y: npc.y,
          z: npc.z,
          targetX: npc.targetX,
          targetZ: npc.targetZ,
          goal: npc.currentGoal,
          task: npc.currentTask,
          message: npc.statusMessage
        });
      };

      // 破壊・設置のブロードキャスト受信 (SE / パーティクル)
      this.room.onMessage('voxel_destroyed', (data: { x: number; y: number; z: number }) => {
        onVoxelRemove(data.x, data.y, data.z, true);
      });

      this.room.onMessage('voxel_placed', (data: { x: number; y: number; z: number; type: VoxelType }) => {
        onVoxelAdd(data.x, data.y, data.z, data.type, true);
      });

      return true;
    } catch (e) {
      this.isConnected = false;
      onStatusChange('🟡 OFFLINE (ソロプレイ)', false);
      console.warn('⚠️ Colyseus サーバー非接続。スタンドアロンモードで動作します。', e);
      return false;
    }
  }

  public sendPlayerMove(x: number, y: number, z: number, rotationY: number): void {
    if (this.isConnected && this.room) {
      this.room.send('player_move', { x, y, z, rotationY, rotY: rotationY });
    }
  }

  public sendPlayerAction(action: 'mine' | 'build', x: number, y: number, z: number): void {
    if (this.isConnected && this.room) {
      this.room.send('player_action', { action, actionType: action, targetX: x, targetZ: z, x, z });
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

// ============================================================================
// 9. メインアプリケーション統合 (VoxelVRMApp)
// ============================================================================
export class VoxelVRMApp {
  private scene: THREE.Scene;
  private renderer: THREE.WebGLRenderer;
  private cameraSys: IsometricCameraSystem;
  private avatar: VRMAvatarController;
  private world: DynamicVoxelWorld;
  private network: NetworkController;
  private sounds = new SoundManager();
  private particles: VoxelParticleSystem;
  private clock = new THREE.Clock();

  // リモートプレイヤー & NPC
  private remotePlayers = new Map<string, RemotePlayerRenderer>();
  private npcRenderer: NPCRenderer;

  // レイキャスト & カーソル表示
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private cursorMesh: THREE.LineSegments;
  private selectedVoxelType: VoxelType = 'grass';

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
    this.particles = new VoxelParticleSystem(this.scene);
    this.network = new NetworkController();

    // NPC 表示の初期化
    this.npcRenderer = new NPCRenderer('お手伝いピコ');
    this.scene.add(this.npcRenderer.group);

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
    this.setupPaletteUI();

    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.cameraSys.handleResize(window.innerWidth, window.innerHeight);
    });

    // 初期起動
    this.initApp();
  }

  private async initApp(): Promise<void> {
    // ネットワーク同期リスナーの設定
    await this.network.connect(
      (msg, isOnline) => {
        this.updateNetworkStatus(msg, isOnline);
      },
      // ボクセル追加 (他プレイヤー/サーバー同期)
      (x, y, z, type, isRemote) => {
        if (isRemote) {
          // 既にローカルで同一タイプなら再構築スキップ (冪等)
          const current = this.world.getVoxelType(x, y, z);
          if (current !== type) {
            this.world.addVoxel(x, y, z, type);
            this.sounds.playPlace();
          }
        }
      },
      // ボクセル削除 (他プレイヤー/サーバー同期)
      (x, y, z, isRemote) => {
        if (isRemote) {
          const type = this.world.getVoxelType(x, y, z);
          if (type) {
            const color = this.world.getVoxelColor(type);
            this.world.removeVoxel(x, y, z);
            this.particles.spawnExplosion(x, y, z, color);
            this.sounds.playMine();
          }
        }
      },
      // 他プレイヤー参加
      (id, name, x, y, z) => {
        if (!this.remotePlayers.has(id)) {
          const rp = new RemotePlayerRenderer(id, name);
          rp.group.position.set(x, y, z);
          rp.targetPos.set(x, y, z);
          this.scene.add(rp.group);
          this.remotePlayers.set(id, rp);
          console.log(`👤 リモートプレイヤー表示: ${name}`);
        }
      },
      // 他プレイヤー退出
      (id) => {
        const rp = this.remotePlayers.get(id);
        if (rp) {
          this.scene.remove(rp.group);
          this.remotePlayers.delete(id);
        }
      },
      // 他プレイヤー移動
      (id, x, y, z, rotY) => {
        const rp = this.remotePlayers.get(id);
        if (rp) {
          rp.targetPos.set(x, y, z);
          rp.targetRotY = rotY;
        }
      },
      // GOAP NPC 更新
      (npc) => {
        this.npcRenderer.targetPos.set(npc.x, npc.y, npc.z);
        this.npcRenderer.updateSpeechBubble(npc.message);

        // HUD 更新
        const nameEl = document.getElementById('npc-name');
        const goalEl = document.getElementById('npc-goal');
        const taskEl = document.getElementById('npc-task');
        const msgEl = document.getElementById('npc-message');

        if (nameEl) nameEl.innerText = npc.name;
        if (goalEl) goalEl.innerText = `目標: ${npc.goal}`;
        if (taskEl) taskEl.innerText = `タスク: ${npc.task}`;
        if (msgEl) {
          if (msgEl.innerText !== `「${npc.message}」`) {
            this.sounds.playNotice();
          }
          msgEl.innerText = `「${npc.message}」`;
        }
      }
    );

    // サンプルVRMモデルのロード
    const sampleVrmUrl = 'https://pixiv.github.io/three-vrm/packages/three-vrm/examples/models/VRM1_Constraint_Sample.vrm';
    try {
      this.updateStatus('VRMアバター読み込み中...');
      await this.avatar.loadVRMFromUrl(sampleVrmUrl);
      this.updateStatus('🟢 準備完了: WASDで移動 / 左クリックで採掘 / 右クリックで設置');
    } catch {
      this.updateStatus('🟡 VRM待機中: 手元の .vrm ファイルを画面へドラッグ＆ドロップしてください');
    }

    this.animate();
  }

  private setupLighting(): void {
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xfffaed, 1.25);
    dirLight.position.set(40, 60, 30);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    this.scene.add(dirLight);
  }

  private setupInputListeners(): void {
    window.addEventListener('keydown', (e) => {
      this.keys[e.key.toLowerCase()] = true;
      const keyMap: Record<string, VoxelType> = {
        '1': 'grass',
        '2': 'dirt',
        '3': 'stone',
        '4': 'wood',
        '5': 'leaves',
        '6': 'plank'
      };

      if (keyMap[e.key]) {
        this.selectVoxelType(keyMap[e.key]);
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
        // --- 左クリック: 即時採掘・破壊 (Optimistic Update) ---
        const type = this.world.getVoxelType(x, y, z);
        if (type && this.world.removeVoxel(x, y, z)) {
          // 即時エフェクト & SE
          this.avatar.triggerMiningAnimation();
          this.particles.spawnExplosion(x, y, z, this.world.getVoxelColor(type));
          this.sounds.playMine();

          // サーバー通知
          this.network.sendDestroyVoxel(x, y, z);
          this.network.sendPlayerAction('mine', x, y, z);
        }
      } else if (e.button === 2) {
        // --- 右クリック: 即時建設・配置 (Optimistic Update) ---
        const nx = x + normal.x;
        const ny = y + normal.y;
        const nz = z + normal.z;

        if (this.world.addVoxel(nx, ny, nz, this.selectedVoxelType)) {
          // 即時エフェクト & SE
          this.avatar.triggerBuildingAnimation();
          this.sounds.playPlace();

          // サーバー通知
          this.network.sendPlaceVoxel(nx, ny, nz, this.selectedVoxelType);
          this.network.sendPlayerAction('build', nx, ny, nz);
        }
      }
    });

    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private setupPaletteUI(): void {
    const slots = document.querySelectorAll('.palette-slot');
    slots.forEach((slot) => {
      slot.addEventListener('click', () => {
        const type = slot.getAttribute('data-type') as VoxelType;
        if (type) {
          this.selectVoxelType(type);
        }
      });
    });
  }

  private selectVoxelType(type: VoxelType): void {
    if (this.selectedVoxelType === type) return;
    this.selectedVoxelType = type;
    this.sounds.playSelect();

    // UIハイライト更新
    const slots = document.querySelectorAll('.palette-slot');
    slots.forEach((s) => {
      if (s.getAttribute('data-type') === type) {
        s.classList.add('active');
      } else {
        s.classList.remove('active');
      }
    });
  }

  private setupDragAndDrop(): void {
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (files && files.length > 0 && files[0].name.endsWith('.vrm')) {
        const blobUrl = URL.createObjectURL(files[0]);
        this.avatar.loadVRMFromUrl(blobUrl);
        this.updateStatus(`✅ VRMモデル適用: ${files[0].name}`);
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

  private updateStatus(msg: string): void {
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.innerText = msg;
  }

  private updateNetworkStatus(msg: string, isOnline: boolean): void {
    const badge = document.getElementById('network-badge');
    if (badge) {
      badge.innerText = msg;
      if (isOnline) {
        badge.classList.remove('offline');
      } else {
        badge.classList.add('offline');
      }
    }
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

    // ネットワーク位置送信 (y座標およびrotationYを含める)
    if (inputDir.lengthSq() > 0) {
      this.network.sendPlayerMove(
        this.avatar.position.x,
        this.avatar.position.y,
        this.avatar.position.z,
        this.avatar.rotationY
      );
    }

    // パーティクル & リモートプレイヤー & NPC の更新
    this.particles.update(delta);
    this.remotePlayers.forEach((rp) => rp.update(delta));
    this.npcRenderer.update(delta);

    // マウスホバー & Raycast 更新
    this.updateRaycastHover();

    // アイソメトリックカメラ追従
    this.cameraSys.updateCameraFollow(this.avatar.position);

    this.renderer.render(this.scene, this.cameraSys.camera);
  };
}

// アプリケーション起動
new VoxelVRMApp();
