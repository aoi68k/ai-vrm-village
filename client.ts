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

// VRMメタデータ抽出ヘルパー
export function getVRMMeta(vrm: VRM, fallbackFileName?: string): { title: string; author: string } {
  const meta = (vrm as unknown as { meta?: { name?: string; title?: string; authors?: string[]; author?: string } }).meta || {};
  let title = meta.name || meta.title;
  if (!title || title === 'VRM Model' || title === 'Unnamed') {
    if (fallbackFileName) {
      title = fallbackFileName.replace(/\.vrm$/i, '');
    } else {
      title = 'VRM Model';
    }
  }
  const author = Array.isArray(meta.authors)
    ? meta.authors.join(', ')
    : meta.author || '不明';
  return { title, author };
}

// VRM顔写真の自動オフスクリーン撮影 (Face Capture: スタジオライティング付きで明るく鮮明に撮影)
export function captureVRMFace(renderer: THREE.WebGLRenderer, scene: THREE.Scene, vrm: VRM): string {
  const lightsToAdd: THREE.Object3D[] = [];
  const disposables: { dispose: () => void }[] = [];

  try {
    const width = 256;
    const height = 256;
    const target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
    });

    // 頭部ボーン位置の取得
    const headNode = vrm.humanoid?.getNormalizedBoneNode('head') || vrm.humanoid?.getRawBoneNode('head');
    const headWorldPos = new THREE.Vector3();
    if (headNode) {
      headNode.getWorldPosition(headWorldPos);
    } else {
      headWorldPos.copy(vrm.scene.position).add(new THREE.Vector3(0, 1.4, 0));
    }

    // 専用クローズアップカメラ (画角狭め 24度)
    const faceCam = new THREE.PerspectiveCamera(24, 1, 0.1, 20);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(vrm.scene.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(vrm.scene.quaternion);

    faceCam.position.copy(headWorldPos).addScaledVector(forward, 0.65).add(new THREE.Vector3(0, 0.03, 0));
    faceCam.lookAt(headWorldPos.x, headWorldPos.y + 0.01, headWorldPos.z);

    // 📸 撮影専用ライティング (光量を抑え、斜め上から当てて自然な陰影と立体感を演出)
    // 1. メインライト (右斜め前方・やや上方からのやわらかな光: 強度 0.8)
    const keyLight = new THREE.DirectionalLight(0xfffaea, 0.8);
    keyLight.position.copy(headWorldPos)
      .addScaledVector(forward, 0.6)
      .addScaledVector(right, 0.45)
      .add(new THREE.Vector3(0, 0.35, 0));
    keyLight.target.position.copy(headWorldPos);
    lightsToAdd.push(keyLight, keyLight.target);
    disposables.push(keyLight);

    // 2. 補助フィルライト (反対側からのごく淡い光で、陰影を残しつつ暗部の輪郭を保持: 強度 0.2)
    const fillLight = new THREE.DirectionalLight(0xe2e8f0, 0.2);
    fillLight.position.copy(headWorldPos)
      .addScaledVector(forward, 0.5)
      .addScaledVector(right, -0.4)
      .add(new THREE.Vector3(0, 0.1, 0));
    fillLight.target.position.copy(headWorldPos);
    lightsToAdd.push(fillLight, fillLight.target);
    disposables.push(fillLight);

    // 一時的にシーンへ照明を追加
    lightsToAdd.forEach((obj) => scene.add(obj));

    // 撮影時だけ背景を無効化して水色の背景色の写り込みを防ぐ
    const prevBackground = scene.background;
    scene.background = null;

    const prevTarget = renderer.getRenderTarget();
    const prevClearColor = new THREE.Color();
    const prevClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(prevClearColor);

    renderer.setRenderTarget(target);
    renderer.setClearColor(0xf0f0f0, 1); // 白系ニュートラル背景（水色帯を防ぐ）
    renderer.clear();
    renderer.render(scene, faceCam);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClearColor, prevClearAlpha); // クリアカラーを元に戻す

    // 背景を元に戻す
    scene.background = prevBackground;

    const pixelBuffer = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixelBuffer);
    target.dispose();

    // 上下反転補正して Canvas から DataURL を生成
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    const imgData = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcIdx = ((height - 1 - y) * width + x) * 4;
        const dstIdx = (y * width + x) * 4;
        imgData.data[dstIdx] = pixelBuffer[srcIdx];
        imgData.data[dstIdx + 1] = pixelBuffer[srcIdx + 1];
        imgData.data[dstIdx + 2] = pixelBuffer[srcIdx + 2];
        imgData.data[dstIdx + 3] = pixelBuffer[srcIdx + 3];
      }
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL('image/png');
  } catch (err) {
    console.warn('VRM顔キャプチャに失敗しました:', err);
    return '';
  } finally {
    // 撮影完了後に専用ライトを確実にシーンから撤去・破棄
    lightsToAdd.forEach((obj) => scene.remove(obj));
    disposables.forEach((d) => d.dispose());
  }
}

// ネットワーク共有用にアバター画像を 64x64 JPEG に軽量圧縮
export function createAvatarThumbnail(dataUrl: string, size = 64): Promise<string> {
  return new Promise((resolve) => {
    if (!dataUrl) return resolve('');
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      } else {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// ============================================================================
// 1. クォータービュー カメラシステム (360度旋回・自由パン・ズーム・視点連動)
// ============================================================================
export class IsometricCameraSystem {
  public camera: THREE.OrthographicCamera;
  private aspect: number;
  public targetPosition = new THREE.Vector3(0, 0, 0);

  // 球座標パラメータ
  public theta: number = Math.PI / 4; // 現在の水平角度 (初期45度)
  public targetTheta: number = Math.PI / 4; // 45度吸着目標角度
  public elevation: number = 0.6154797; // 見下ろし角度 (約35.264度: atan(1/√2))
  public distance: number = 138.564; // カメラ距離 (80 * √3)
  private zoomLevel = 2.25; // 初期拡大率 (キャラとワールドが近くしっかり見える距離感)
  public isFollowingAvatar = true; // アバター追従フラグ

  constructor(aspectRatio: number, frustumSize: number = 25) {
    this.aspect = aspectRatio;
    const d = frustumSize;
    this.camera = new THREE.OrthographicCamera(
      -d * this.aspect, d * this.aspect, d, -d, 1, 1000
    );
    this.camera.zoom = this.zoomLevel;
    this.camera.updateProjectionMatrix();
    this.updateCameraPosition();
  }

  // カメラ位置の再計算と注視点更新
  public updateCameraPosition(): void {
    const hDist = this.distance * Math.cos(this.elevation);
    const camY = this.targetPosition.y + this.distance * Math.sin(this.elevation);
    const camX = this.targetPosition.x + hDist * Math.cos(this.theta);
    const camZ = this.targetPosition.z + hDist * Math.sin(this.theta);

    this.camera.position.set(camX, camY, camZ);
    this.camera.lookAt(this.targetPosition);
  }

  // アバター追従更新 (パン操作されていない場合のみ追従、45度吸着目標角度へ滑らかに補間)
  public updateCameraFollow(targetPos: THREE.Vector3, lerpFactor = 0.08): void {
    if (this.isFollowingAvatar) {
      this.targetPosition.lerp(targetPos, lerpFactor);
    }
    // 45度吸着角度へ滑らかにLerp補間
    this.theta = lerpAngle(this.theta, this.targetTheta, 0.22);
    this.updateCameraPosition();
  }

  // 45度（π/4）刻みステップ回転 (direction: -1 で時計回り45度, +1 で反時計回り45度)
  public rotateStep(direction: number): void {
    const step = Math.PI / 4;
    this.targetTheta += direction * step;
  }

  // 最も近い45度に吸着スナップ
  public snapToNearest45(): void {
    const step = Math.PI / 4;
    this.targetTheta = Math.round(this.targetTheta / step) * step;
  }

  // 左ドラッグ: 地面を直接掴んで動かすパン移動
  public pan(deltaScreenX: number, deltaScreenY: number): void {
    this.isFollowingAvatar = false;
    const factor = (25 / (this.camera.zoom * window.innerHeight)) * 2.2;
    const right = this.getRightOnPlane();
    const forward = this.getForwardOnPlane();

    // 掴んだ地面を引っ張る直感的操作 (マウス右移動で視界は左へ、マウス下移動で視界は上へ)
    this.targetPosition.addScaledVector(right, -deltaScreenX * factor);
    this.targetPosition.addScaledVector(forward, deltaScreenY * factor);
    this.updateCameraPosition();
  }

  // マウスホイールズーム (0.4〜4.0倍)
  public handleZoom(deltaY: number): void {
    this.zoomLevel = THREE.MathUtils.clamp(this.zoomLevel - deltaY * 0.0012, 0.4, 4.0);
    this.camera.zoom = this.zoomLevel;
    this.camera.updateProjectionMatrix();
  }

  // 自キャラ追従への復帰
  public resetToAvatar(): void {
    this.isFollowingAvatar = true;
  }

  // 現在のカメラの画面上方向 (奥) のXZ平面単位ベクトル
  public getForwardOnPlane(): THREE.Vector3 {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    return forward.normalize();
  }

  // 現在のカメラの画面右方向のXZ平面単位ベクトル
  public getRightOnPlane(): THREE.Vector3 {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    right.y = 0;
    return right.normalize();
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
// 2. VRM アバターコントローラー (自然な立ち姿 ＆ 視点追従WASD移動)
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
  private actionDuration = 0.45;
  
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
          VRMUtils.rotateVRM0(vrm); // VRM 0.x / 1.x の向きを標準化

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
          
          // ロード直後から両腕を自然に下ろした立ちポーズを適用
          this.applyIdlePose(1.0);
          this.vrm.update(0.016);

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

  public triggerMiningAnimation(): void {
    this.currentState = 'mining';
    this.actionTimer = this.actionDuration;
  }

  public triggerBuildingAnimation(): void {
    this.currentState = 'building';
    this.actionTimer = this.actionDuration;
  }

  // 自然な立ち姿 (両腕を体側に下ろしたAポーズ: 左腕は-Z、右腕は+Z)
  private applyIdlePose(lerpSpeed = 1.0): void {
    if (!this.vrm?.humanoid) return;
    const humanoid = this.vrm.humanoid;

    const leftUpperArm = humanoid.getNormalizedBoneNode('leftUpperArm');
    const rightUpperArm = humanoid.getNormalizedBoneNode('rightUpperArm');
    const leftLowerArm = humanoid.getNormalizedBoneNode('leftLowerArm');
    const rightLowerArm = humanoid.getNormalizedBoneNode('rightLowerArm');

    const leftUpperLeg = humanoid.getNormalizedBoneNode('leftUpperLeg');
    const rightUpperLeg = humanoid.getNormalizedBoneNode('rightUpperLeg');
    const leftLowerLeg = humanoid.getNormalizedBoneNode('leftLowerLeg');
    const rightLowerLeg = humanoid.getNormalizedBoneNode('rightLowerLeg');

    if (leftUpperArm) {
      leftUpperArm.rotation.x = THREE.MathUtils.lerp(leftUpperArm.rotation.x, 0.05, lerpSpeed);
      leftUpperArm.rotation.z = THREE.MathUtils.lerp(leftUpperArm.rotation.z, -1.25, lerpSpeed);
    }
    if (rightUpperArm) {
      rightUpperArm.rotation.x = THREE.MathUtils.lerp(rightUpperArm.rotation.x, 0.05, lerpSpeed);
      rightUpperArm.rotation.z = THREE.MathUtils.lerp(rightUpperArm.rotation.z, 1.25, lerpSpeed);
    }
    if (leftLowerArm) leftLowerArm.rotation.x = THREE.MathUtils.lerp(leftLowerArm.rotation.x, -0.15, lerpSpeed);
    if (rightLowerArm) rightLowerArm.rotation.x = THREE.MathUtils.lerp(rightLowerArm.rotation.x, -0.15, lerpSpeed);

    if (leftUpperLeg) leftUpperLeg.rotation.x = THREE.MathUtils.lerp(leftUpperLeg.rotation.x, 0, lerpSpeed);
    if (rightUpperLeg) rightUpperLeg.rotation.x = THREE.MathUtils.lerp(rightUpperLeg.rotation.x, 0, lerpSpeed);
    if (leftLowerLeg) leftLowerLeg.rotation.x = THREE.MathUtils.lerp(leftLowerLeg.rotation.x, 0, lerpSpeed);
    if (rightLowerLeg) rightLowerLeg.rotation.x = THREE.MathUtils.lerp(rightLowerLeg.rotation.x, 0, lerpSpeed);
  }

  public update(
    delta: number,
    screenInput: { screenX: number; screenY: number },
    currentGroundY: number,
    cameraSys: IsometricCameraSystem
  ): void {
    this.position.y = THREE.MathUtils.lerp(this.position.y, currentGroundY, 0.2);

    const { screenX, screenY } = screenInput;
    const hasInput = screenX !== 0 || screenY !== 0;

    if (hasInput) {
      // カメラの回転角度に合わせて画面入力ベクトルを地面XZに射影
      // これにより、カメラがどの角度に回転していても常にWは画面上、Sは画面下、Dは画面右、Aは画面左へ移動！
      const forward = cameraSys.getForwardOnPlane();
      const right = cameraSys.getRightOnPlane();

      const moveDir = new THREE.Vector3();
      moveDir.addScaledVector(right, screenX);
      moveDir.addScaledVector(forward, screenY);
      moveDir.normalize();

      this.position.addScaledVector(moveDir, this.moveSpeed * delta);
      
      const targetRotation = Math.atan2(moveDir.x, moveDir.z);
      this.rotationY = lerpAngle(this.rotationY, targetRotation, 0.25);

      if (this.actionTimer <= 0) {
        this.currentState = 'walking';
      }
    } else if (this.actionTimer <= 0) {
      this.currentState = 'idle';
    }

    if (this.actionTimer > 0) {
      this.actionTimer -= delta;
      if (this.actionTimer <= 0) {
        this.currentState = hasInput ? 'walking' : 'idle';
      }
    }

    if (this.vrm) {
      this.vrm.scene.position.copy(this.position);
      this.vrm.scene.rotation.y = this.rotationY;

      this.animateHumanoidBones(delta, hasInput);
      this.animateExpressions(delta);
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
        leftUpperArm.rotation.z = -0.8;
      }
      return;
    }

    if (this.currentState === 'building') {
      const progress = 1.0 - Math.max(0, this.actionTimer / this.actionDuration);
      const pushFactor = Math.sin(progress * Math.PI);

      if (chest) chest.rotation.x = -0.1 * pushFactor;
      if (rightUpperArm) {
        rightUpperArm.rotation.x = -0.8 * pushFactor;
        rightUpperArm.rotation.z = -0.4;
      }
      if (leftUpperArm) {
        leftUpperArm.rotation.x = -0.8 * pushFactor;
        leftUpperArm.rotation.z = 0.4;
      }
      if (rightLowerArm) rightLowerArm.rotation.x = -0.4 * pushFactor;
      if (leftLowerArm) leftLowerArm.rotation.x = -0.4 * pushFactor;
      return;
    }

    if (isMoving) {
      this.walkTime += delta * 11.0;

      const legAngle = Math.sin(this.walkTime) * 0.55;
      if (leftUpperLeg) leftUpperLeg.rotation.x = legAngle;
      if (rightUpperLeg) rightUpperLeg.rotation.x = -legAngle;

      if (leftLowerLeg) leftLowerLeg.rotation.x = legAngle < 0 ? Math.abs(legAngle) * 0.8 : 0.05;
      if (rightLowerLeg) rightLowerLeg.rotation.x = legAngle > 0 ? Math.abs(legAngle) * 0.8 : 0.05;

      const armAngle = Math.sin(this.walkTime) * 0.45;
      if (leftUpperArm) {
        leftUpperArm.rotation.x = -armAngle;
        leftUpperArm.rotation.z = -1.15; // 腕を下ろしたまま自然に振る
      }
      if (rightUpperArm) {
        rightUpperArm.rotation.x = armAngle;
        rightUpperArm.rotation.z = 1.15;
      }
      if (leftLowerArm) leftLowerArm.rotation.x = -0.2;
      if (rightLowerArm) rightLowerArm.rotation.x = -0.2;

      if (spine) {
        spine.position.y = Math.abs(Math.sin(this.walkTime * 2)) * 0.04;
        spine.rotation.y = -legAngle * 0.15;
      }
      if (head) head.rotation.y = legAngle * 0.08;
    } else {
      this.walkTime += delta * 2.0;
      const breath = Math.sin(this.walkTime) * 0.03;

      if (spine) {
        spine.position.y = THREE.MathUtils.lerp(spine.position.y, 0, 0.1);
        spine.rotation.y = THREE.MathUtils.lerp(spine.rotation.y, 0, 0.1);
      }
      if (chest) chest.rotation.x = breath;
      if (head) head.rotation.x = -breath * 0.5;

      this.applyIdlePose(0.15);
    }
  }

  private animateExpressions(delta: number): void {
    if (!this.vrm?.expressionManager) return;

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
// 3. Web Audio API による効果音マネージャー
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

  public playMine(): void {
    this.initCtx();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

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

  public playPlace(): void {
    this.initCtx();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(260, now);
    osc.frequency.exponentialRampToValueAtTime(440, now + 0.07);
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.09);
  }

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

  public playNotice(): void {
    this.initCtx();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    [0, 0.08].forEach((offset, idx) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(idx === 0 ? 523.25 : 783.99, now + offset);
      gain.gain.setValueAtTime(0.12, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.15);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.15);
    });
  }

  // 参加呼び鈴音（澄んだピンポーン 🔔）
  public playDoorbell(): void {
    this.initCtx();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    // 1音目: ピン (E5: ~659.25Hz)
    const osc1 = this.ctx.createOscillator();
    const gain1 = this.ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, now);
    gain1.gain.setValueAtTime(0.18, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    osc1.connect(gain1);
    gain1.connect(this.ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.55);

    // 2音目: ポーン (C5: ~523.25Hz)
    const osc2 = this.ctx.createOscillator();
    const gain2 = this.ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(523.25, now + 0.2);
    gain2.gain.setValueAtTime(0.2, now + 0.2);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.2 + 0.85);
    osc2.connect(gain2);
    gain2.connect(this.ctx.destination);
    osc2.start(now + 0.2);
    osc2.stop(now + 0.2 + 0.85);
  }

  // 退出音（ポ・ロ・ン… 🚪）
  public playLeave(): void {
    this.initCtx();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    const freqs = [440, 369.99, 293.66]; // A4 -> F#4 -> D4 の優しい下降音
    freqs.forEach((freq, idx) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      const startTime = now + idx * 0.11;
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0.14, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.38);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + 0.38);
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

      p.velocity.y += gravity * delta;
      p.mesh.position.addScaledVector(p.velocity, delta);

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
  private head: THREE.Mesh;

  // ネームプレート
  private nameCanvas: HTMLCanvasElement;
  private nameCtx: CanvasRenderingContext2D | null;
  private nameSprite: THREE.Sprite;

  // 頭上スピーチバブル
  private bubbleCanvas: HTMLCanvasElement;
  private bubbleCtx: CanvasRenderingContext2D | null;
  private bubbleSprite: THREE.Sprite;
  private bubbleTimer = 0;
  private currentBubbleMsg = '';
  private currentBubbleIsStamp = false;
  private currentZoom = 2.25;

  constructor(
    public id: string,
    public name: string,
    public authType: string = 'guest',
    public userHash: string = '~guest'
  ) {
    const bodyGeo = new THREE.BoxGeometry(0.5, 0.7, 0.35);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3b82f6 });
    this.body = new THREE.Mesh(bodyGeo, bodyMat);
    this.body.position.y = 0.5;
    this.body.castShadow = true;
    this.group.add(this.body);

    const headGeo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
    const headMat = new THREE.MeshStandardMaterial({ color: 0xfde047 });
    this.head = new THREE.Mesh(headGeo, headMat);
    this.head.position.y = 1.05;
    this.head.castShadow = true;
    this.group.add(this.head);

    const armGeo = new THREE.BoxGeometry(0.15, 0.5, 0.15);
    const armMat = new THREE.MeshStandardMaterial({ color: 0x60a5fa });

    this.leftArm = new THREE.Mesh(armGeo, armMat.clone());
    this.leftArm.position.set(-0.35, 0.5, 0);
    this.group.add(this.leftArm);

    this.rightArm = new THREE.Mesh(armGeo, armMat.clone());
    this.rightArm.position.set(0.35, 0.5, 0);
    this.group.add(this.rightArm);

    // 1. ネームプレート（名前 ＋ 🐱認証バッジ / 👤ゲストバッジ）
    this.nameCanvas = document.createElement('canvas');
    this.nameCanvas.width = 384;
    this.nameCanvas.height = 80;
    this.nameCtx = this.nameCanvas.getContext('2d');

    const nameTexture = new THREE.CanvasTexture(this.nameCanvas);
    const nameMat = new THREE.SpriteMaterial({ map: nameTexture, depthTest: false, depthWrite: false });
    this.nameSprite = new THREE.Sprite(nameMat);
    this.nameSprite.renderOrder = 998;
    this.nameSprite.position.set(0, 1.55, 0);
    this.nameSprite.scale.set(1.9, 0.4, 1);
    this.group.add(this.nameSprite);
    this.updateNamePlate(name, authType, userHash);

    // 2. スピーチバブル
    this.bubbleCanvas = document.createElement('canvas');
    this.bubbleCanvas.width = 512;
    this.bubbleCanvas.height = 128;
    this.bubbleCtx = this.bubbleCanvas.getContext('2d');

    const bubbleTexture = new THREE.CanvasTexture(this.bubbleCanvas);
    const bubbleMat = new THREE.SpriteMaterial({ map: bubbleTexture, depthTest: false, depthWrite: false });
    this.bubbleSprite = new THREE.Sprite(bubbleMat);
    this.bubbleSprite.renderOrder = 999;
    this.bubbleSprite.position.set(0, 2.15, 0);
    this.bubbleSprite.scale.set(2.6, 0.65, 1);
    this.bubbleSprite.visible = false;
    this.group.add(this.bubbleSprite);
  }

  // VRM由来の配色をボックスマンに適用 (hair→頭, skin→腕, clothing→胴体)
  public setColors(hair: string, skin: string, clothing: string): void {
    (this.head.material as THREE.MeshStandardMaterial).color.set(hair);
    (this.body.material as THREE.MeshStandardMaterial).color.set(clothing);
    (this.leftArm.material as THREE.MeshStandardMaterial).color.set(skin);
    (this.rightArm.material as THREE.MeshStandardMaterial).color.set(skin);
  }

  public updateNamePlate(name: string, authType = 'guest', userHash = '~guest'): void {
    this.name = name;
    this.authType = authType;
    this.userHash = userHash;
    if (!this.nameCtx) return;

    this.nameCtx.clearRect(0, 0, 384, 80);
    this.nameCtx.fillStyle = 'rgba(15, 23, 42, 0.8)';
    this.nameCtx.strokeStyle = authType === 'github' ? '#10b981' : '#64748b';
    this.nameCtx.lineWidth = 3;
    this.nameCtx.roundRect(8, 8, 368, 64, 14);
    this.nameCtx.fill();
    this.nameCtx.stroke();

    this.nameCtx.fillStyle = '#ffffff';
    this.nameCtx.font = 'bold 22px sans-serif';
    this.nameCtx.textAlign = 'left';
    this.nameCtx.textBaseline = 'middle';
    const trimmedName = name.length > 10 ? name.substring(0, 10) + '..' : name;
    this.nameCtx.fillText(trimmedName, 24, 40);

    // ハッシュバッジ描画
    const badgeText = authType === 'github' ? `🐱${userHash}` : `👤${userHash}`;
    this.nameCtx.fillStyle = authType === 'github' ? '#6ee7b7' : '#cbd5e1';
    this.nameCtx.font = '17px monospace';
    this.nameCtx.textAlign = 'right';
    this.nameCtx.fillText(badgeText, 360, 40);

    this.nameSprite.material.map!.needsUpdate = true;
  }

  public setAuthBadge(authType: string, userHash: string): void {
    this.updateNamePlate(this.name, authType, userHash);
  }

  private renderBubbleContent(): void {
    if (!this.bubbleCtx) return;
    this.bubbleCtx.clearRect(0, 0, 512, 128);

    const isCompact = this.currentZoom < 1.35;
    // 画面ピクセル基準でのワールドスケール計算 (常に画面上で安定した十分な大きさを確保)
    const viewHeight = window.innerHeight || 800;
    const unitsPerPixel = 50 / (this.currentZoom * viewHeight);

    if (isCompact) {
      // 縮小時: 画面上で 160px × 46px のコンパクトピル
      const targetW = 160 * unitsPerPixel;
      const targetH = 46 * unitsPerPixel;

      this.bubbleCtx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      this.bubbleCtx.strokeStyle = this.currentBubbleIsStamp ? '#f59e0b' : '#38bdf8';
      this.bubbleCtx.lineWidth = 5;
      this.bubbleCtx.roundRect(100, 16, 312, 96, 48);
      this.bubbleCtx.fill();
      this.bubbleCtx.stroke();

      this.bubbleCtx.textAlign = 'center';
      this.bubbleCtx.textBaseline = 'middle';

      if (this.currentBubbleIsStamp) {
        const emoji = Array.from(this.currentBubbleMsg)[0] || '💬';
        this.bubbleCtx.font = '48px sans-serif';
        this.bubbleCtx.fillStyle = '#fcd34d';
        this.bubbleCtx.fillText(emoji, 256, 64);
      } else {
        const shortName = this.name.length > 5 ? this.name.substring(0, 5) : this.name;
        this.bubbleCtx.font = 'bold 30px sans-serif';
        this.bubbleCtx.fillStyle = '#38bdf8';
        this.bubbleCtx.fillText(`${shortName}: 💬 …`, 256, 64);
      }

      this.bubbleSprite.scale.set(targetW, targetH, 1);
      this.bubbleSprite.position.set(0, 1.45 + targetH / 2 + 12 * unitsPerPixel, 0);
    } else {
      // 通常時: 画面上で 320px × 80px のしっかり読めるフルサイズ吹き出し
      const targetW = 320 * unitsPerPixel;
      const targetH = 80 * unitsPerPixel;

      this.bubbleCtx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      this.bubbleCtx.strokeStyle = this.currentBubbleIsStamp ? '#f59e0b' : '#38bdf8';
      this.bubbleCtx.lineWidth = 5;
      this.bubbleCtx.roundRect(10, 10, 492, 108, 22);
      this.bubbleCtx.fill();
      this.bubbleCtx.stroke();

      this.bubbleCtx.textAlign = 'center';
      this.bubbleCtx.textBaseline = 'middle';

      if (this.currentBubbleIsStamp) {
        this.bubbleCtx.fillStyle = '#fcd34d';
        this.bubbleCtx.font = 'bold 38px sans-serif';
        this.bubbleCtx.fillText(this.currentBubbleMsg, 256, 64);
      } else {
        this.bubbleCtx.fillStyle = '#f8fafc';
        this.bubbleCtx.font = 'bold 28px sans-serif';
        const displayMsg = this.currentBubbleMsg.length > 18 ? this.currentBubbleMsg.substring(0, 18) + '...' : this.currentBubbleMsg;
        this.bubbleCtx.fillText(displayMsg, 256, 64);
      }

      this.bubbleSprite.scale.set(targetW, targetH, 1);
      this.bubbleSprite.position.set(0, 1.45 + targetH / 2 + 15 * unitsPerPixel, 0);
    }

    this.bubbleSprite.material.map!.needsUpdate = true;
  }

  public showSpeechBubble(msg: string, isStamp = false): void {
    this.currentBubbleMsg = msg;
    this.currentBubbleIsStamp = isStamp;
    this.renderBubbleContent();
    this.bubbleSprite.visible = true;
    this.bubbleTimer = 4.0;
  }

  public update(delta: number, currentGroundY: number = 0.5, cameraZoom = 1.55): void {
    this.group.position.x += (this.targetPos.x - this.group.position.x) * 0.2;
    this.group.position.z += (this.targetPos.z - this.group.position.z) * 0.2;
    this.group.rotation.y = lerpAngle(this.group.rotation.y, this.targetRotY, 0.2);

    const isMoving = Math.hypot(this.targetPos.x - this.group.position.x, this.targetPos.z - this.group.position.z) > 0.05;
    if (isMoving) {
      this.walkTime += delta * 10;
      const angle = Math.sin(this.walkTime) * 0.6;
      this.leftArm.rotation.x = angle;
      this.rightArm.rotation.x = -angle;
      this.group.position.y = currentGroundY + Math.abs(Math.sin(this.walkTime * 2)) * 0.08;
    } else {
      this.leftArm.rotation.x = 0;
      this.rightArm.rotation.x = 0;
      this.group.position.y = THREE.MathUtils.lerp(this.group.position.y, currentGroundY, 0.2);
    }

    if (this.bubbleTimer > 0) {
      this.bubbleTimer -= delta;
      if (this.bubbleTimer <= 0) {
        this.bubbleSprite.visible = false;
      } else if (Math.abs(this.currentZoom - cameraZoom) > 0.04) {
        this.currentZoom = cameraZoom;
        this.renderBubbleContent();
      }
    }
  }
}

// ============================================================================
// 6. GOAP 自律型手助けNPC (お手伝いピコ) 3Dレンダラー
// ============================================================================
export class NPCRenderer {
  public group = new THREE.Group();
  public targetPos = new THREE.Vector3(2, 1.5, 2);
  private walkTime = 0;
  private idleTime = 0;
  private speechSprite: THREE.Sprite;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private currentMsg = '';
  private currentZoom = 2.25;

  constructor(public name: string = 'お手伝いピコ') {
    const bodyGeo = new THREE.BoxGeometry(0.55, 0.6, 0.45);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.4 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.45;
    body.castShadow = true;
    body.receiveShadow = true;
    this.group.add(body);

    const headGeo = new THREE.BoxGeometry(0.48, 0.45, 0.45);
    const headMat = new THREE.MeshStandardMaterial({ color: 0xf0f9ff, roughness: 0.3 });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 0.95;
    head.castShadow = true;
    head.receiveShadow = true;
    this.group.add(head);

    const antGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.3);
    const antMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b });
    const ant = new THREE.Mesh(antGeo, antMat);
    ant.position.y = 1.3;
    this.group.add(ant);

    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 128;
    this.ctx = this.canvas.getContext('2d');

    const texture = new THREE.CanvasTexture(this.canvas);
    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      depthWrite: false
    });
    this.speechSprite = new THREE.Sprite(spriteMat);
    this.speechSprite.renderOrder = 999;
    this.speechSprite.position.set(0, 1.85, 0);
    this.speechSprite.scale.set(2.4, 0.6, 1);
    this.group.add(this.speechSprite);

    this.updateSpeechBubble('こんにちは！');
  }

  private renderBubbleContent(): void {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, 512, 128);

    const isCompact = this.currentZoom < 1.35;
    // 画面ピクセル基準でのワールドスケール計算 (常に画面上で安定した十分な大きさを確保)
    const viewHeight = window.innerHeight || 800;
    const unitsPerPixel = 50 / (this.currentZoom * viewHeight);

    if (isCompact) {
      // 縮小時: 画面上で 160px × 46px のコンパクトピル
      const targetW = 160 * unitsPerPixel;
      const targetH = 46 * unitsPerPixel;

      this.ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      this.ctx.strokeStyle = '#38bdf8';
      this.ctx.lineWidth = 5;
      this.ctx.roundRect(100, 16, 312, 96, 48);
      this.ctx.fill();
      this.ctx.stroke();

      this.ctx.fillStyle = '#38bdf8';
      this.ctx.font = 'bold 36px sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText('🤖 ピコ: 💬 …', 256, 64);

      this.speechSprite.scale.set(targetW, targetH, 1);
      this.speechSprite.position.set(0, 1.35 + targetH / 2 + 12 * unitsPerPixel, 0);
    } else {
      // 通常時: 画面上で 360px × 90px のしっかり読めるフルサイズ吹き出し
      const targetW = 360 * unitsPerPixel;
      const targetH = 90 * unitsPerPixel;

      this.ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      this.ctx.strokeStyle = '#38bdf8';
      this.ctx.lineWidth = 5;
      this.ctx.roundRect(10, 10, 492, 108, 22);
      this.ctx.fill();
      this.ctx.stroke();

      this.ctx.textAlign = 'left';
      this.ctx.textBaseline = 'alphabetic';

      this.ctx.fillStyle = '#38bdf8';
      this.ctx.font = 'bold 28px sans-serif';
      this.ctx.fillText(`🤖 ${this.name}`, 32, 48);

      this.ctx.fillStyle = '#ffffff';
      this.ctx.font = 'bold 24px sans-serif';
      const trimmed = this.currentMsg.length > 20 ? this.currentMsg.substring(0, 20) + '...' : this.currentMsg;
      this.ctx.fillText(trimmed, 32, 92);

      this.speechSprite.scale.set(targetW, targetH, 1);
      this.speechSprite.position.set(0, 1.35 + targetH / 2 + 15 * unitsPerPixel, 0);
    }

    this.speechSprite.material.map!.needsUpdate = true;
  }

  public updateSpeechBubble(msg: string): void {
    if (this.currentMsg === msg) return;
    this.currentMsg = msg;
    if (this.speechSprite.visible) {
      this.renderBubbleContent();
    }
  }

  // 吹き出しのON/OFF切り替え
  public setBubbleVisible(visible: boolean): void {
    this.speechSprite.visible = visible;
    if (visible) this.renderBubbleContent();
  }

  public get isBubbleVisible(): boolean {
    return this.speechSprite.visible;
  }

  public update(delta: number, currentGroundY: number = 0.5, cameraZoom = 1.55): void {
    const dx = this.targetPos.x - this.group.position.x;
    const dz = this.targetPos.z - this.group.position.z;
    const hDist = Math.hypot(dx, dz);

    if (hDist > 0.08) {
      // 離れ具合に応じた歩行速度 (一定ペースでゆったり歩く)
      const moveSpeed = hDist > 6 ? 2.2 : 1.2;
      const step = Math.min(moveSpeed * delta, hDist);

      this.group.position.x += (dx / hDist) * step;
      this.group.position.z += (dz / hDist) * step;

      // 進行方向へのなだらかな振り向き
      const targetAngle = Math.atan2(dx, dz);
      this.group.rotation.y = lerpAngle(this.group.rotation.y, targetAngle, 0.08);

      // ゆったりしたトコトコ歩行ステップ (激しい上下跳ねを抑える)
      const stepFreq = hDist > 6 ? 7.5 : 5.0;
      this.walkTime += delta * stepFreq;
      this.group.position.y = currentGroundY + Math.abs(Math.sin(this.walkTime)) * 0.07;
    } else {
      // 到着・待機時はその場で穏やかに呼吸のように微振動
      this.idleTime += delta * 2.0;
      const breathingY = currentGroundY + Math.sin(this.idleTime) * 0.015;
      this.group.position.y = THREE.MathUtils.lerp(this.group.position.y, breathingY, 0.1);
    }

    // ズーム変更時のスケール・縮小表示再計算
    if (Math.abs(this.currentZoom - cameraZoom) > 0.04) {
      this.currentZoom = cameraZoom;
      this.renderBubbleContent();
    }
  }
}

// ============================================================================
// 7. 動的ボクセルワールド (6種対応・バッチ最適化)
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
    for (let x = -this.worldSize / 2; x <= this.worldSize / 2; x++) {
      for (let z = -this.worldSize / 2; z <= this.worldSize / 2; z++) {
        const key = `${x},0,${z}`;
        this.voxelMap.set(key, 'grass');

        if (Math.hypot(x, z) < 6) {
          this.voxelMap.set(`${x},1,${z}`, 'dirt');
        }
      }
    }

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

  public addVoxelsBatch(voxels: Array<{ x: number; y: number; z: number; type: VoxelType }>): boolean {
    let added = false;
    voxels.forEach((v) => {
      const key = `${v.x},${v.y},${v.z}`;
      if (!this.voxelMap.has(key)) {
        this.voxelMap.set(key, v.type);
        added = true;
      }
    });
    if (added) this.rebuildMeshes();
    return added;
  }

  public removeVoxelsBatch(coords: Array<{ x: number; y: number; z: number }>): boolean {
    let removed = false;
    coords.forEach((c) => {
      const key = `${c.x},${c.y},${c.z}`;
      if (this.voxelMap.has(key)) {
        this.voxelMap.delete(key);
        removed = true;
      }
    });
    if (removed) this.rebuildMeshes();
    return removed;
  }

  public getInstancedMeshes(): THREE.InstancedMesh[] {
    return Array.from(this.meshMap.values());
  }
}

export function getAutoServerUrl(): string {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('server')) {
    return urlParams.get('server')!;
  }
  const host = window.location.hostname || 'localhost';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${host}:2567`;
}

// ============================================================================
// 8. Colyseus ネットワーク同期コントローラー
// ============================================================================
export class NetworkController {
  private client: Client;
  public room: Room | null = null;
  public isConnected = false;

  constructor(serverUrl: string = getAutoServerUrl()) {
    this.client = new Client(serverUrl);
  }

  public async connect(
    initialOptions: { name: string; authType: string; githubId?: string; githubUsername?: string },
    onStatusChange: (msg: string, isOnline: boolean) => void,
    onVoxelAdd: (x: number, y: number, z: number, type: VoxelType, isRemote: boolean) => void,
    onVoxelRemove: (x: number, y: number, z: number, isRemote: boolean) => void,
    onPlayerJoin: (id: string, name: string, x: number, y: number, z: number, authType?: string, userHash?: string) => void,
    onPlayerLeave: (id: string) => void,
    onPlayerMove: (id: string, x: number, y: number, z: number, rotY: number) => void,
    onNPCUpdate: (npc: { id: string; name: string; x: number; y: number; z: number; targetX: number; targetZ: number; goal: string; task: string; message: string }) => void,
    onChatMessage: (msg: { sessionId: string; senderName: string; userHash: string; authType: string; text: string; isStamp: boolean }) => void,
    onPlayerRenamed: (data: { id: string; name: string }) => void,
    onPlayerAuthUpdated: (data: { id: string; authType: string; userHash: string; githubUsername: string }) => void,
    onAuthInit?: (data: { userHash: string; authType: string; githubUsername: string; name: string }) => void,
    onPlayerColors?: (data: { id: string; hair: string; skin: string; clothing: string }) => void,
    onPlayerAvatar?: (data: { id: string; dataUrl: string }) => void
  ): Promise<boolean> {
    try {
      onStatusChange('Colyseus サーバーへ接続中...', false);
      this.room = await this.client.joinOrCreate('voxel_room', initialOptions);
      this.isConnected = true;
      onStatusChange(`🟢 ONLINE`, true);
      console.log('✅ Colyseus ルーム参加完了:', this.room.id);

      this.room.state.voxels.onAdd = (voxel: { x: number; y: number; z: number; type: string }) => {
        onVoxelAdd(voxel.x, voxel.y, voxel.z, (voxel.type as VoxelType) || 'dirt', true);
      };

      this.room.state.voxels.onRemove = (voxel: { x: number; y: number; z: number }) => {
        onVoxelRemove(voxel.x, voxel.y, voxel.z, true);
      };

      this.room.state.players.onAdd = (player: { id: string; name: string; x: number; y: number; z: number; rotationY: number; authType?: string; userHash?: string }, sessionId: string) => {
        if (sessionId !== this.room?.sessionId) {
          onPlayerJoin(sessionId, player.name || `Player_${sessionId.substring(0, 4)}`, player.x, player.y, player.z, player.authType || 'guest', player.userHash || '~guest');
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

      // Colyseus State 全体パッチリスナー (毎Tick確実にNPCや他プレイヤーの位置を同期)
      this.room.onStateChange((state: any) => {
        if (state.npcs) {
          state.npcs.forEach((npc: any) => {
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
          });
        }
        if (state.players) {
          state.players.forEach((player: any, sessionId: string) => {
            if (sessionId !== this.room?.sessionId) {
              // onAdd が漏れた・遅延した場合のフォールバック登録
              onPlayerJoin(sessionId, player.name || `Player_${sessionId.substring(0, 4)}`, player.x, player.y, player.z, player.authType || 'guest', player.userHash || '~guest');
              onPlayerMove(sessionId, player.x, player.y, player.z, player.rotationY || 0);
            }
          });
        }
      });

      this.room.onMessage('voxel_destroyed', (data: { x: number; y: number; z: number }) => {
        onVoxelRemove(data.x, data.y, data.z, true);
      });

      this.room.onMessage('voxel_placed', (data: { x: number; y: number; z: number; type: VoxelType }) => {
        onVoxelAdd(data.x, data.y, data.z, data.type, true);
      });

      this.room.onMessage('chat_message', (data: { sessionId: string; senderName: string; userHash: string; authType: string; text: string; isStamp: boolean }) => {
        onChatMessage(data);
      });

      this.room.onMessage('player_renamed', (data: { id: string; name: string }) => {
        onPlayerRenamed(data);
      });

      this.room.onMessage('player_auth_updated', (data: { id: string; authType: string; userHash: string; githubUsername: string }) => {
        onPlayerAuthUpdated(data);
      });

      this.room.onMessage('player_colors_broadcast', (data: { id: string; hair: string; skin: string; clothing: string }) => {
        onPlayerColors?.(data);
      });

      this.room.onMessage('player_avatar_broadcast', (data: { id: string; dataUrl: string }) => {
        onPlayerAvatar?.(data);
      });

      this.room.onMessage('auth_init', (data: { userHash: string; authType: string; githubUsername: string; name: string }) => {
        onAuthInit?.(data);
      });

      // サーバー切断時・エラー時のオフライン復帰ハンドラー
      this.room.onLeave((code) => {
        console.warn('🚪 Colyseus ルーム切断 (code:', code, ')。オフライン自律モードに移行します。');
        this.isConnected = false;
        this.room = null;
        onStatusChange('🟡 OFFLINE (ソロプレイ)', false);
      });

      this.room.onError((code, message) => {
        console.warn('⚠️ Colyseus ルームエラー (code:', code, '):', message);
        this.isConnected = false;
        onStatusChange('🟡 OFFLINE (ソロプレイ)', false);
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

  public sendChatMessage(text: string, isStamp = false): void {
    if (this.isConnected && this.room) {
      this.room.send('chat_message', { text, isStamp });
    }
  }

  public sendPlayerRename(name: string): void {
    if (this.isConnected && this.room) {
      this.room.send('player_rename', { name });
    }
  }

  public sendPlayerColors(hair: string, skin: string, clothing: string): void {
    if (this.isConnected && this.room) {
      this.room.send('player_colors', { hair, skin, clothing });
    }
  }

  public sendPlayerAvatar(dataUrl: string): void {
    if (this.isConnected && this.room && dataUrl) {
      this.room.send('player_avatar', { dataUrl });
    }
  }

  public sendAuthVerify(authType: 'github' | 'guest', githubId?: string, githubUsername?: string): void {
    if (this.isConnected && this.room) {
      this.room.send('auth_verify', { authType, githubId, githubUsername });
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
  private remotePlayerNames = new Map<string, string>();
  private isInitialSyncDone = false;
  private npcRenderer: NPCRenderer;

  // プレイヤープロフィール & 認証
  private myPlayerName = 'あなた';
  private myAuthType: 'github' | 'guest' = 'guest';
  private myUserHash = '~guest';
  private myGithubUsername = '';
  private myAvatarFaceDataUrl = '';
  private vrmModelTitle = 'Sample VRM';
  private vrmModelAuthor = 'Pixiv';
  private isProfileModalOpen = false;

  // リモートプレイヤーの認証情報マップ (sessionId -> { authType, userHash, githubUsername })
  private remotePlayerAuth = new Map<string, { authType: string; userHash: string; githubUsername?: string }>();

  // リモートプレイヤーのアバターアイコン (sessionId -> base64 data URL)
  private remotePlayerAvatars = new Map<string, string>();

  // 自分自身の頭上吹き出し
  private myBubbleSprite: THREE.Sprite | null = null;
  private myBubbleCtx: CanvasRenderingContext2D | null = null;
  private myBubbleTimer = 0;
  private myBubbleMsg = '';
  private myBubbleIsStamp = false;
  private myBubbleZoom = 2.25;

  // ローカル自律NPC AI状態 (サーバー未接続時・同期途絶時のフォールバック)
  private localNpcTimer = 0;
  private localNpcNextDecisionTime = 4.0;
  private lastPlayerActionTime = 0;
  private lastPlayerActionPos = new THREE.Vector3(0, 0, 0);
  private localNpcAngle = 0;
  private lastServerNpcUpdateTime = 0;

  // 編集モード状態
  private isEditMode = false;
  private currentTool: 'place' | 'destroy' | 'stamp' = 'place';
  private brushSize = 1;
  private selectedStamp: 'tree' | 'gazebo' | 'wall' | 'stairs' = 'tree';
  private selectedVoxelType: VoxelType = 'grass';

  // レイキャスト & ゴースト表示
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private cursorMesh: THREE.LineSegments;
  private ghostGroup: THREE.Group;
  private selectedTarget: { x: number; y: number; z: number; normal: THREE.Vector3 } | null = null;

  // マウスドラッグ判定 (左ドラッグ: パン / 右ドラッグ: 回転)
  private leftMouseDown = false;
  private rightMouseDown = false;
  private hasLeftDragged = false;
  private hasRightDragged = false;
  private leftStartX = 0;
  private leftStartY = 0;
  private rightStartX = 0;
  private rightStartY = 0;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private lastRotateMouseX = 0;

  // キー入力
  private keys: { [key: string]: boolean } = {};

  constructor() {
    const container = document.getElementById('canvas-container') || document.body;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
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

    this.npcRenderer = new NPCRenderer('お手伝いピコ');
    const initNpcY = this.world.getGroundHeight(2, 2);
    this.npcRenderer.group.position.set(2, initNpcY, 2);
    this.npcRenderer.targetPos.set(2, initNpcY, 2);
    this.scene.add(this.npcRenderer.group);

    // 黄色枠カーソル
    const boxGeo = new THREE.BoxGeometry(1.02, 1.02, 1.02);
    const wireGeo = new THREE.WireframeGeometry(boxGeo);
    this.cursorMesh = new THREE.LineSegments(
      wireGeo,
      new THREE.LineBasicMaterial({ color: 0xffea00, linewidth: 2 })
    );
    this.cursorMesh.visible = false;
    this.scene.add(this.cursorMesh);

    // 半透明ゴーストプレビュー用グループ
    this.ghostGroup = new THREE.Group();
    this.ghostGroup.visible = false;
    this.scene.add(this.ghostGroup);

    this.setupLighting();
    this.loadStoredProfile();
    this.setupMySpeechBubble();
    this.setupInputListeners();
    this.setupDragAndDrop();
    this.setupUIHandlers();
    this.setupProfileModalUI();
    this.setupChatUI();

    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.cameraSys.handleResize(window.innerWidth, window.innerHeight);
    });

    this.initApp();
  }

  private async initApp(): Promise<void> {
    const savedGhId = localStorage.getItem('vrm_village_github_id') || undefined;
    await this.network.connect(
      {
        name: this.myPlayerName,
        authType: this.myAuthType,
        githubId: savedGhId,
        githubUsername: this.myGithubUsername || undefined
      },
      (msg, isOnline) => this.updateNetworkStatus(msg, isOnline),
      (x, y, z, type, isRemote) => {
        if (isRemote) {
          const current = this.world.getVoxelType(x, y, z);
          if (current !== type) {
            this.world.addVoxel(x, y, z, type);
            this.sounds.playPlace();
          }
        }
      },
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
      (id, name, x, y, z, authType, userHash) => {
        const isNew = !this.remotePlayers.has(id);
        if (isNew) {
          const rp = new RemotePlayerRenderer(id, name);
          rp.group.position.set(x, y, z);
          rp.targetPos.set(x, y, z);
          rp.setAuthBadge(authType || 'guest', userHash || '~guest');
          this.scene.add(rp.group);
          this.remotePlayers.set(id, rp);
          this.remotePlayerNames.set(id, name);
          this.remotePlayerAuth.set(id, { authType: authType || 'guest', userHash: userHash || '~guest' });

          this.updatePlayerListUI();

          // 初期同期完了後の新規参加なら呼び鈴を鳴らす
          if (this.isInitialSyncDone) {
            this.sounds.playDoorbell();
            this.updateStatus(`🔔 ${name} さんが村に参加しました！`);
          }
        }
      },
      (id) => {
        const rp = this.remotePlayers.get(id);
        const name = this.remotePlayerNames.get(id) || 'プレイヤー';
        if (rp) {
          this.scene.remove(rp.group);
          this.remotePlayers.delete(id);
          this.remotePlayerNames.delete(id);
          this.remotePlayerAuth.delete(id);

          this.updatePlayerListUI();

          if (this.isInitialSyncDone) {
            this.sounds.playLeave();
            this.updateStatus(`👋 ${name} さんが村から退出しました`);
          }
        }
      },
      (id, x, y, z, rotY) => {
        const rp = this.remotePlayers.get(id);
        if (rp) {
          rp.targetPos.set(x, y, z);
          rp.targetRotY = rotY;
        }
      },
      (npc) => {
        this.lastServerNpcUpdateTime = performance.now();
        this.npcRenderer.targetPos.set(npc.x, npc.y, npc.z);
        this.npcRenderer.updateSpeechBubble(npc.message);

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
      },
      (chatMsg) => {
        if (chatMsg.sessionId !== this.network.room?.sessionId) {
          const rp = this.remotePlayers.get(chatMsg.sessionId);
          if (rp) {
            rp.showSpeechBubble(chatMsg.text, chatMsg.isStamp);
          }
          const avatarUrl = this.remotePlayerAvatars.get(chatMsg.sessionId);
          this.addChatMessage(chatMsg.senderName, chatMsg.userHash, chatMsg.authType, chatMsg.text, chatMsg.isStamp, false, avatarUrl, chatMsg.sessionId);
          this.sounds.playNotice();
        }
      },
      (renamedData) => {
        // 自分のリネームなら myPlayerName を更新するだけ（remotePlayerNames には追加しない）
        if (renamedData.id === this.network.room?.sessionId) {
          this.myPlayerName = renamedData.name;
          this.updatePlayerListUI();
          return;
        }
        this.remotePlayerNames.set(renamedData.id, renamedData.name);
        const rp = this.remotePlayers.get(renamedData.id);
        if (rp) {
          const auth = this.remotePlayerAuth.get(renamedData.id);
          rp.setAuthBadge(auth?.authType || 'guest', auth?.userHash || '~guest');
        }
        this.updatePlayerListUI();
      },
      (authData) => {
        if (authData.id === this.network.room?.sessionId) {
          this.myAuthType = authData.authType as 'github' | 'guest';
          this.myUserHash = authData.userHash;
          this.myGithubUsername = authData.githubUsername;
          localStorage.setItem('vrm_village_auth_type', this.myAuthType);
          localStorage.setItem('vrm_village_user_hash', this.myUserHash);
          if (this.myGithubUsername) {
            localStorage.setItem('vrm_village_github_username', this.myGithubUsername);
          }
          this.updateProfileBadgeUI();
        } else {
          this.remotePlayerAuth.set(authData.id, {
            authType: authData.authType,
            userHash: authData.userHash,
            githubUsername: authData.githubUsername
          });
          const rp = this.remotePlayers.get(authData.id);
          if (rp) {
            rp.setAuthBadge(authData.authType, authData.userHash);
          }
          this.updatePlayerListUI();
        }
      },
      (initData) => {
        this.myUserHash = initData.userHash;
        this.myAuthType = initData.authType as 'github' | 'guest';
        if (initData.githubUsername) this.myGithubUsername = initData.githubUsername;
        localStorage.setItem('vrm_village_user_hash', this.myUserHash);
        localStorage.setItem('vrm_village_auth_type', this.myAuthType);
        this.updateProfileBadgeUI();
      },
      // onPlayerColors: VRM配色をリモートプレイヤーのボックスマンに適用
      (colorData) => {
        const rp = this.remotePlayers.get(colorData.id);
        if (rp) {
          rp.setColors(colorData.hair, colorData.skin, colorData.clothing);
        }
      },
      // onPlayerAvatar: アバターアイコンを受信してプレイヤー一覧・チャットに反映
      (avatarData) => {
        this.remotePlayerAvatars.set(avatarData.id, avatarData.dataUrl);
        this.updatePlayerListUI(); // プレイヤー一覧を再描画
        this.updateChatAvatars(avatarData.id, avatarData.dataUrl); // 該当プレイヤーの過去チャットにもアバター適用
      }
    );

    // 初期プレイヤー一覧UI描画
    this.updatePlayerListUI();

    // 接続初期同期完了フラグ（1秒後に新規参加判定を開始）
    setTimeout(() => {
      this.isInitialSyncDone = true;
    }, 1000);

    const sampleVrmUrl = 'https://pixiv.github.io/three-vrm/packages/three-vrm/examples/models/VRM1_Constraint_Sample.vrm';
    try {
      this.updateStatus('VRMアバター読み込み中...');
      const vrm = await this.avatar.loadVRMFromUrl(sampleVrmUrl);
      this.onAvatarModelLoaded(vrm);
      this.updateStatus('🟢 準備完了: WASDで移動 / Eキーでワールド編集');
    } catch {
      this.updateStatus('🟡 VRM待機中: 手元の .vrm ファイルを画面へドラッグ＆ドロップしてください');
    }

    this.animate();
  }

  // ワールド内プレイヤー一覧UI更新
  private updatePlayerListUI(): void {
    const countEl = document.getElementById('player-count');
    const container = document.getElementById('player-list-container');
    if (!container) return;

    const totalCount = 1 + this.remotePlayerNames.size;
    if (countEl) countEl.innerText = `${totalCount}`;

    container.innerHTML = '';

    // 1. 自分（ローカルプレイヤー）
    const selfItem = document.createElement('div');
    selfItem.className = 'player-item';
    const selfBadgeClass = this.myAuthType === 'github' ? 'auth-badge github' : 'auth-badge guest';
    const selfBadgeText = this.myAuthType === 'github' ? `🐱${this.myUserHash}` : `👤${this.myUserHash}`;
    const selfAvatarHtml = this.myAvatarFaceDataUrl
      ? `<img src="${this.myAvatarFaceDataUrl}" class="player-list-avatar" alt="Avatar" />`
      : `<span class="player-dot"></span>`;
    selfItem.innerHTML = `
      ${selfAvatarHtml}
      <span class="player-name">${this.myPlayerName}</span>
      <span class="${selfBadgeClass}" style="font-size: 10px; padding: 1px 6px;">${selfBadgeText}</span>
      <span class="player-badge self">YOU</span>
    `;
    container.appendChild(selfItem);

    // 2. リモートプレイヤー
    this.remotePlayerNames.forEach((name, id) => {
      const auth = this.remotePlayerAuth.get(id);
      const isGh = auth?.authType === 'github';
      const hash = auth?.userHash || '~guest';
      const badgeClass = isGh ? 'auth-badge github' : 'auth-badge guest';
      const badgeText = isGh ? `🐱${hash}` : `👤${hash}`;
      const avatarUrl = this.remotePlayerAvatars.get(id);
      const remoteAvatarHtml = avatarUrl
        ? `<img src="${avatarUrl}" class="player-list-avatar" alt="Avatar" />`
        : `<span class="player-dot"></span>`;

      const pItem = document.createElement('div');
      pItem.className = 'player-item';
      pItem.innerHTML = `
        ${remoteAvatarHtml}
        <span class="player-name">${name}</span>
        <span class="${badgeClass}" style="font-size: 10px; padding: 1px 6px;">${badgeText}</span>
      `;
      container.appendChild(pItem);
    });
  }

  // --- プロフィール保存・復元 & UI更新 ---
  private loadStoredProfile(): void {
    const storedName = localStorage.getItem('vrm_village_player_name');
    if (storedName) this.myPlayerName = storedName;

    const storedAuth = localStorage.getItem('vrm_village_auth_type') as 'github' | 'guest' | null;
    if (storedAuth === 'github') {
      this.myAuthType = 'github';
      this.myGithubUsername = localStorage.getItem('vrm_village_github_username') || '';
      const savedHash = localStorage.getItem('vrm_village_user_hash');
      if (savedHash) this.myUserHash = savedHash;
    } else {
      this.myAuthType = 'guest';
      const savedHash = localStorage.getItem('vrm_village_user_hash');
      if (savedHash) {
        this.myUserHash = savedHash;
      } else {
        const randomId = Math.random().toString(36).substring(2, 8);
        this.myUserHash = `~${randomId}`;
        localStorage.setItem('vrm_village_user_hash', this.myUserHash);
      }
    }

    this.updateProfileBadgeUI();
  }

  private updateProfileBadgeUI(): void {
    const nameEl = document.getElementById('profile-display-name');
    if (nameEl) nameEl.innerText = this.myPlayerName;

    const badgeEl = document.getElementById('profile-user-badge');
    if (badgeEl) {
      if (this.myAuthType === 'github') {
        badgeEl.className = 'auth-badge github';
        badgeEl.innerText = `🐱${this.myUserHash}`;
      } else {
        badgeEl.className = 'auth-badge guest';
        badgeEl.innerText = `👤${this.myUserHash}`;
      }
    }

    const modalInputName = document.getElementById('input-player-name') as HTMLInputElement | null;
    if (modalInputName && document.activeElement !== modalInputName) {
      modalInputName.value = this.myPlayerName;
    }

    const unverifiedBox = document.getElementById('auth-unverified-box');
    const verifiedBox = document.getElementById('auth-verified-box');
    const modalAuthUser = document.getElementById('modal-auth-username');
    const modalAuthHash = document.getElementById('modal-auth-hash');

    if (this.myAuthType === 'github') {
      if (unverifiedBox) unverifiedBox.style.display = 'none';
      if (verifiedBox) verifiedBox.style.display = 'flex';
      if (modalAuthUser) modalAuthUser.innerText = `@${this.myGithubUsername || 'GitHub User'}`;
      if (modalAuthHash) {
        modalAuthHash.className = 'auth-badge github';
        modalAuthHash.innerText = `🐱${this.myUserHash}`;
      }
    } else {
      if (unverifiedBox) unverifiedBox.style.display = 'flex';
      if (verifiedBox) verifiedBox.style.display = 'none';
      if (modalAuthHash) {
        modalAuthHash.className = 'auth-badge guest';
        modalAuthHash.innerText = `👤${this.myUserHash}`;
      }
    }

    this.updatePlayerListUI();
  }

  private onAvatarModelLoaded(vrm: VRM | null, fallbackFileName?: string): void {
    if (!vrm) return;
    const meta = getVRMMeta(vrm, fallbackFileName);
    this.vrmModelTitle = meta.title;
    this.vrmModelAuthor = meta.author;

    const modalTitleEl = document.getElementById('modal-vrm-title');
    const modalAuthorEl = document.getElementById('modal-vrm-author');
    if (modalTitleEl) modalTitleEl.innerText = this.vrmModelTitle;
    if (modalAuthorEl) modalAuthorEl.innerText = this.vrmModelAuthor;

    // 名前が未設定またはデフォルト値（「あなた」など）だった場合、モデル名をプレイヤー名に代入
    const savedCustomName = localStorage.getItem('vrm_village_player_name');
    const isDefaultName = !savedCustomName ||
      this.myPlayerName === 'あなた' ||
      this.myPlayerName.startsWith('Player_') ||
      this.myPlayerName === 'VRM Model';

    if (isDefaultName && this.vrmModelTitle && this.vrmModelTitle !== 'VRM Model') {
      this.myPlayerName = this.vrmModelTitle.substring(0, 16);
      localStorage.setItem('vrm_village_player_name', this.myPlayerName);
      this.network.sendPlayerRename(this.myPlayerName);
      this.updateProfileBadgeUI();
    }

    // VRMの顔を自動オフスクリーン撮影
    const faceDataUrl = captureVRMFace(this.renderer, this.scene, vrm);
    if (faceDataUrl) {
      this.myAvatarFaceDataUrl = faceDataUrl;

      const badgeImg = document.getElementById('profile-avatar-img') as HTMLImageElement | null;
      const badgePlaceholder = document.getElementById('profile-avatar-placeholder');
      if (badgeImg) {
        badgeImg.src = faceDataUrl;
        badgeImg.style.display = 'block';
      }
      if (badgePlaceholder) badgePlaceholder.style.display = 'none';

      const modalImg = document.getElementById('modal-avatar-img') as HTMLImageElement | null;
      const modalPlaceholder = document.getElementById('modal-avatar-placeholder');
      if (modalImg) {
        modalImg.src = faceDataUrl;
        modalImg.style.display = 'block';
      }
      if (modalPlaceholder) modalPlaceholder.style.display = 'none';

      // アバター画像をサムネイル化してサーバーへ共有＆プレイヤー一覧更新
      createAvatarThumbnail(faceDataUrl, 64).then((thumb) => {
        this.network.sendPlayerAvatar(thumb);
        this.updatePlayerListUI();
        this.updateChatAvatars('self', thumb);
      });
    }

    // VRMマテリアルから代表色を抽出してサーバーへ送信
    // → 相手のボックスマンをVRM配色に変更するため
    const extractedColors = this.extractVRMColors(vrm);
    this.network.sendPlayerColors(extractedColors.hair, extractedColors.skin, extractedColors.clothing);
  }

  // VRMの主要マテリアルから Hair / Skin / Clothing の代表色を16進文字列で抽出
  private extractVRMColors(vrm: VRM): { hair: string; skin: string; clothing: string } {
    const colors: { hair: THREE.Color | null; skin: THREE.Color | null; clothing: THREE.Color | null } = {
      hair: null, skin: null, clothing: null
    };

    vrm.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((mat: THREE.Material) => {
        const m = mat as THREE.MeshStandardMaterial;
        if (!m.color) return;
        const name = (m.name || mesh.name || '').toLowerCase();
        if (!colors.hair && (name.includes('hair') || name.includes('髪'))) {
          colors.hair = m.color.clone();
        } else if (!colors.skin && (name.includes('face') || name.includes('skin') || name.includes('顔') || name.includes('肌'))) {
          colors.skin = m.color.clone();
        } else if (!colors.clothing && (name.includes('body') || name.includes('cloth') || name.includes('shirt') || name.includes('dress') || name.includes('服') || name.includes('上着'))) {
          colors.clothing = m.color.clone();
        }
      });
    });

    const toHex = (c: THREE.Color | null, fallback: string) =>
      c ? '#' + c.getHexString() : fallback;

    return {
      hair:     toHex(colors.hair,     '#1e293b'), // デフォルト: 暗めの黒髪
      skin:     toHex(colors.skin,     '#fde68a'), // デフォルト: 明るい肌色
      clothing: toHex(colors.clothing, '#3b82f6'), // デフォルト: 青いボディ
    };
  }

  // --- 自分の頭上吹き出しシステム ---
  private setupMySpeechBubble(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    this.myBubbleCtx = canvas.getContext('2d');

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      depthWrite: false
    });
    this.myBubbleSprite = new THREE.Sprite(spriteMat);
    this.myBubbleSprite.renderOrder = 998;
    this.myBubbleSprite.scale.set(2.6, 0.65, 1);
    this.myBubbleSprite.visible = false;
    this.scene.add(this.myBubbleSprite);
  }

  private renderMyBubbleContent(): void {
    if (!this.myBubbleCtx || !this.myBubbleSprite) return;
    this.myBubbleCtx.clearRect(0, 0, 512, 128);

    const isCompact = this.myBubbleZoom < 1.35;
    // 画面ピクセル基準でのワールドスケール計算 (常に画面上で安定した十分な大きさを確保)
    const viewHeight = window.innerHeight || 800;
    const unitsPerPixel = 50 / (this.myBubbleZoom * viewHeight);

    if (isCompact) {
      // 縮小時: 画面上で 160px × 46px のコンパクトピル
      const targetW = 160 * unitsPerPixel;
      const targetH = 46 * unitsPerPixel;

      this.myBubbleCtx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      this.myBubbleCtx.strokeStyle = this.myBubbleIsStamp ? '#f59e0b' : '#10b981';
      this.myBubbleCtx.lineWidth = 5;
      this.myBubbleCtx.roundRect(100, 16, 312, 96, 48);
      this.myBubbleCtx.fill();
      this.myBubbleCtx.stroke();

      this.myBubbleCtx.textAlign = 'center';
      this.myBubbleCtx.textBaseline = 'middle';

      if (this.myBubbleIsStamp) {
        const emoji = Array.from(this.myBubbleMsg)[0] || '💬';
        this.myBubbleCtx.font = '48px sans-serif';
        this.myBubbleCtx.fillStyle = '#fcd34d';
        this.myBubbleCtx.fillText(emoji, 256, 64);
      } else {
        const shortName = this.myPlayerName.length > 5 ? this.myPlayerName.substring(0, 5) : this.myPlayerName;
        this.myBubbleCtx.font = 'bold 30px sans-serif';
        this.myBubbleCtx.fillStyle = '#6ee7b7';
        this.myBubbleCtx.fillText(`${shortName}: 💬 …`, 256, 64);
      }

      this.myBubbleSprite.scale.set(targetW, targetH, 1);
    } else {
      // 通常時: 画面上で 320px × 80px のしっかり読めるフルサイズ吹き出し
      const targetW = 320 * unitsPerPixel;
      const targetH = 80 * unitsPerPixel;

      this.myBubbleCtx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      this.myBubbleCtx.strokeStyle = this.myBubbleIsStamp ? '#f59e0b' : '#10b981';
      this.myBubbleCtx.lineWidth = 5;
      this.myBubbleCtx.roundRect(10, 10, 492, 108, 22);
      this.myBubbleCtx.fill();
      this.myBubbleCtx.stroke();

      this.myBubbleCtx.textAlign = 'center';
      this.myBubbleCtx.textBaseline = 'middle';

      if (this.myBubbleIsStamp) {
        this.myBubbleCtx.fillStyle = '#fcd34d';
        this.myBubbleCtx.font = 'bold 38px sans-serif';
        this.myBubbleCtx.fillText(this.myBubbleMsg, 256, 64);
      } else {
        this.myBubbleCtx.fillStyle = '#f8fafc';
        this.myBubbleCtx.font = 'bold 28px sans-serif';
        const displayMsg = this.myBubbleMsg.length > 18 ? this.myBubbleMsg.substring(0, 18) + '...' : this.myBubbleMsg;
        this.myBubbleCtx.fillText(displayMsg, 256, 64);
      }

      this.myBubbleSprite.scale.set(targetW, targetH, 1);
    }

    this.myBubbleSprite.material.map!.needsUpdate = true;
  }

  private showMySpeechBubble(msg: string, isStamp = false): void {
    this.myBubbleMsg = msg;
    this.myBubbleIsStamp = isStamp;
    this.renderMyBubbleContent();
    if (this.myBubbleSprite) {
      this.myBubbleSprite.visible = true;
    }
    this.myBubbleTimer = 4.0;
  }

  // --- プロフィール詳細モーダルダイアログ UI制御 ---
  private setupProfileModalUI(): void {
    const badgeEl = document.getElementById('player-profile-badge');
    const modalBackdrop = document.getElementById('profile-modal-backdrop');
    const closeBtn = document.getElementById('btn-close-modal');
    const saveNameBtn = document.getElementById('btn-save-name');
    const nameInput = document.getElementById('input-player-name') as HTMLInputElement | null;
    const demoAuthBtn = document.getElementById('btn-auth-demo');
    const demoUserInput = document.getElementById('input-demo-username') as HTMLInputElement | null;
    const logoutBtn = document.getElementById('btn-auth-logout');
    const githubAuthBtn = document.getElementById('btn-auth-github');
    const openNewTabBtn = document.getElementById('btn-open-second-tab');

    // 左上プロフィールクリックで開く
    badgeEl?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openProfileModal();
    });

    // 閉じるボタン
    closeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeProfileModal();
    });

    // 背景クリックで閉じる
    modalBackdrop?.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) {
        this.closeProfileModal();
      }
    });

    // カード内のクリック貫通防止
    const modalCards = modalBackdrop?.querySelectorAll('.modal-card');
    modalCards?.forEach((c) => c.addEventListener('click', (e) => e.stopPropagation()));

    // 名前変更保存
    const saveName = () => {
      if (!nameInput) return;
      const newName = nameInput.value.trim();
      if (newName && newName !== this.myPlayerName) {
        this.myPlayerName = newName;
        localStorage.setItem('vrm_village_player_name', newName);
        this.network.sendPlayerRename(newName);
        this.updateProfileBadgeUI();
        this.sounds.playSelect();
        this.updateStatus(`✏️ プレイヤー名を「${newName}」に変更しました`);
      }
    };
    saveNameBtn?.addEventListener('click', saveName);
    nameInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        saveName();
        nameInput.blur();
      }
    });

    // デモ認証実行 (ワンクリックで🐱#ハッシュ付与)
    demoAuthBtn?.addEventListener('click', () => {
      const username = (demoUserInput?.value.trim()) || 'Dev' + Math.floor(Math.random() * 900 + 100);
      const demoId = 'demo_' + username.toLowerCase();
      this.myAuthType = 'github';
      this.myGithubUsername = username;
      localStorage.setItem('vrm_village_auth_type', 'github');
      localStorage.setItem('vrm_village_github_username', username);
      localStorage.setItem('vrm_village_github_id', demoId);

      this.network.sendAuthVerify('github', demoId, username);
      this.updateProfileBadgeUI();
      this.sounds.playDoorbell();
      this.updateStatus(`🛡️ デモ認証完了: @${username} として認証されました！`);
    });

    // 認証解除 (ゲストに戻る)
    logoutBtn?.addEventListener('click', () => {
      this.myAuthType = 'guest';
      this.myGithubUsername = '';
      localStorage.removeItem('vrm_village_auth_type');
      localStorage.removeItem('vrm_village_github_username');
      localStorage.removeItem('vrm_village_github_id');

      this.network.sendAuthVerify('guest');
      this.updateProfileBadgeUI();
      this.sounds.playSelect();
      this.updateStatus('👤 認証を解除し、ゲストモードに戻りました');
    });

    // GitHub OAuth認証 (本番用)
    githubAuthBtn?.addEventListener('click', () => {
      const host = window.location.hostname || 'localhost';
      const authUrl = `${window.location.protocol}//${host}:2567/auth/github`;
      window.open(authUrl, '_blank', 'width=600,height=700');
    });

    // 別タブで2人目として参加 (マルチテスト)
    openNewTabBtn?.addEventListener('click', () => {
      window.open(window.location.href, '_blank');
      this.sounds.playSelect();
    });
  }

  private openProfileModal(): void {
    const modal = document.getElementById('profile-modal-backdrop');
    if (modal) {
      modal.style.display = 'flex';
      this.isProfileModalOpen = true;
      this.sounds.playSelect();

      const netStatusEl = document.getElementById('modal-network-status');
      if (netStatusEl) {
        netStatusEl.innerText = this.network.isConnected ? '🟢 ONLINE' : '🟡 OFFLINE';
      }
      const coordsEl = document.getElementById('modal-player-coords');
      if (coordsEl) {
        coordsEl.innerText = `X: ${this.avatar.position.x.toFixed(1)}, Y: ${this.avatar.position.y.toFixed(1)}, Z: ${this.avatar.position.z.toFixed(1)}`;
      }
    }
  }

  private closeProfileModal(): void {
    const modal = document.getElementById('profile-modal-backdrop');
    if (modal) {
      modal.style.display = 'none';
      this.isProfileModalOpen = false;
    }
  }

  // --- チャット ＆ クイックスタンプ UI制御 ---
  private setupChatUI(): void {
    const sendBtn = document.getElementById('btn-chat-send');
    const inputEl = document.getElementById('input-chat-text') as HTMLInputElement | null;
    const stampToggleBtn = document.getElementById('btn-stamp-toggle');
    const stampPopup = document.getElementById('stamp-popup');
    const stampBtns = document.querySelectorAll('.stamp-btn');

    // 送信ボタン
    sendBtn?.addEventListener('click', () => this.sendChatMessageFromInput());

    // Enterキー送信
    inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.sendChatMessageFromInput();
      }
    });

    // スタンプポップアップ開閉トグル
    stampToggleBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!stampPopup) return;
      const isOpen = stampPopup.style.display === 'block';
      stampPopup.style.display = isOpen ? 'none' : 'block';
      this.sounds.playSelect();
    });

    // スタンプボタンクリックで即座に送信
    stampBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const stamp = btn.getAttribute('data-stamp');
        if (stamp) {
          this.sendStampMessage(stamp);
          if (stampPopup) stampPopup.style.display = 'none';
        }
      });
    });

    // ポップアップ以外の画面クリックで閉じる
    window.addEventListener('click', (e) => {
      if (stampPopup && stampPopup.style.display === 'block') {
        if (!stampPopup.contains(e.target as Node) && e.target !== stampToggleBtn) {
          stampPopup.style.display = 'none';
        }
      }
    });

    // チャットパネル内のクリック貫通防止
    const chatPanel = document.getElementById('chat-panel');
    chatPanel?.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  private sendChatMessageFromInput(): void {
    const inputEl = document.getElementById('input-chat-text') as HTMLInputElement | null;
    if (!inputEl) return;
    const text = inputEl.value.trim();
    if (!text) return;

    inputEl.value = '';

    // 自アバターの頭上に吹き出し
    this.showMySpeechBubble(text, false);

    // チャットログに追加
    this.addChatMessage(this.myPlayerName, this.myUserHash, this.myAuthType, text, false, true, this.myAvatarFaceDataUrl, 'self');

    // ネットワークへ送信
    this.network.sendChatMessage(text, false);
    this.sounds.playSelect();
  }

  private sendStampMessage(stamp: string): void {
    // 自アバターの頭上に吹き出し
    this.showMySpeechBubble(stamp, true);

    // チャットログに追加
    this.addChatMessage(this.myPlayerName, this.myUserHash, this.myAuthType, stamp, true, true, this.myAvatarFaceDataUrl, 'self');

    // ネットワークへ送信
    this.network.sendChatMessage(stamp, true);
    this.sounds.playSelect();
  }

  // チャットログコンテナへの行追加
  private addChatMessage(
    senderName: string,
    userHash: string,
    authType: string,
    text: string,
    isStamp: boolean,
    isSelf: boolean,
    avatarUrl?: string,
    senderId?: string
  ): void {
    const logBox = document.getElementById('chat-log-box');
    if (!logBox) return;

    const row = document.createElement('div');
    row.className = 'chat-msg-row';
    if (senderId) {
      row.setAttribute('data-sender-id', senderId);
    } else if (isSelf) {
      row.setAttribute('data-sender-id', 'self');
    }

    const isGh = authType === 'github';
    const badgeClass = isGh ? 'auth-badge github' : 'auth-badge guest';
    const badgeText = isGh ? `🐱${userHash}` : `👤${userHash}`;

    // アバターアイコンHTML
    const avatarHtml = avatarUrl
      ? `<img src="${avatarUrl}" class="chat-avatar-icon" alt="" />`
      : `<span class="chat-avatar-placeholder" style="display:none;"></span>`;

    row.innerHTML = `
      ${avatarHtml}
      <span class="${badgeClass}" style="font-size: 10px; padding: 1px 4px;">${badgeText}</span>
      <span class="chat-sender" style="color: ${isSelf ? '#6ee7b7' : '#38bdf8'};">${senderName}:</span>
      <span class="chat-content" style="${isStamp ? 'font-size: 14px; font-weight: 700; color: #fcd34d;' : ''}">${text}</span>
    `;

    logBox.appendChild(row);

    // 最大30件
    while (logBox.children.length > 30) {
      logBox.removeChild(logBox.children[0]);
    }

    // 最新位置へスクロール
    logBox.scrollTop = logBox.scrollHeight;
  }

  // チャットログ内の特定プレイヤーの過去メッセージにアバターアイコンを後付け反映
  private updateChatAvatars(senderId: string, avatarUrl: string): void {
    const logBox = document.getElementById('chat-log-box');
    if (!logBox || !avatarUrl) return;
    const rows = logBox.querySelectorAll(`.chat-msg-row[data-sender-id="${senderId}"]`);
    rows.forEach((row) => {
      let icon = row.querySelector('.chat-avatar-icon') as HTMLImageElement | null;
      if (icon) {
        icon.src = avatarUrl;
      } else {
        const placeholder = row.querySelector('.chat-avatar-placeholder');
        if (placeholder) {
          const img = document.createElement('img');
          img.className = 'chat-avatar-icon';
          img.src = avatarUrl;
          row.replaceChild(img, placeholder);
        } else {
          const img = document.createElement('img');
          img.className = 'chat-avatar-icon';
          img.src = avatarUrl;
          row.insertBefore(img, row.firstChild);
        }
      }
    });
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
      const activeEl = document.activeElement;
      if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) {
        if (e.key === 'Escape') {
          activeEl.blur();
          this.closeProfileModal();
        }
        return;
      }

      if (e.key === 'Escape') {
        this.closeProfileModal();
      }

      const key = e.key.toLowerCase();
      this.keys[key] = true;

      // Eキー: 編集モード開閉トグル
      if (key === 'e') {
        this.toggleEditMode();
      }

      // 数字キー 1-6: ブロック素材選択
      const keyMap: Record<string, VoxelType> = {
        '1': 'grass', '2': 'dirt', '3': 'stone',
        '4': 'wood', '5': 'leaves', '6': 'plank'
      };
      if (keyMap[key]) {
        this.selectVoxelType(keyMap[key]);
      }
    });

    window.addEventListener('keyup', (e) => {
      const activeEl = document.activeElement;
      if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) {
        return;
      }
      this.keys[e.key.toLowerCase()] = false;
    });

    window.addEventListener('mousemove', (e) => {
      this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    });

    // マウスホイールズーム (Three.js キャンバス上)
    this.renderer.domElement.addEventListener('wheel', (e) => {
      this.cameraSys.handleZoom(e.deltaY);
    }, { passive: true });

    // ポインターダウン (左/右ドラッグ・クリック開始)
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      if (e.button === 0) {
        this.leftMouseDown = true;
        this.hasLeftDragged = false;
        this.leftStartX = e.clientX;
        this.leftStartY = e.clientY;
      } else if (e.button === 2) {
        this.rightMouseDown = true;
        this.hasRightDragged = false;
        this.rightStartX = e.clientX;
        this.rightStartY = e.clientY;
        this.lastRotateMouseX = e.clientX;
      }
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    });

    // ポインター移動 (左ドラッグ: パン / 右ドラッグ: 45度刻みステップ回転)
    window.addEventListener('pointermove', (e) => {
      const dx = e.clientX - this.lastMouseX;
      const dy = e.clientY - this.lastMouseY;

      // 左ボタンドラッグ判定 (移動量5px超でパン操作発動)
      if (this.leftMouseDown) {
        if (!this.hasLeftDragged && Math.hypot(e.clientX - this.leftStartX, e.clientY - this.leftStartY) > 5) {
          this.hasLeftDragged = true;
        }
        if (this.hasLeftDragged) {
          this.cameraSys.pan(dx, dy);
        }
      }

      // 右ボタンドラッグ判定 (45度ステップ回転: 45pxドラッグごとにカチッと回転)
      if (this.rightMouseDown) {
        const diffX = e.clientX - this.lastRotateMouseX;
        const rotateThreshold = 45; // 45px移動ごとに1ステップ(45度)回転

        if (Math.abs(diffX) >= rotateThreshold) {
          this.hasRightDragged = true;
          // 右ドラッグで時計回り(視点右回転: direction = -1)、左ドラッグで反時計回り(direction = 1)
          const direction = diffX > 0 ? -1 : 1;
          this.cameraSys.rotateStep(direction);
          this.sounds.playSelect();
          this.lastRotateMouseX = e.clientX;
        } else if (Math.hypot(e.clientX - this.rightStartX, e.clientY - this.rightStartY) > 5) {
          this.hasRightDragged = true;
        }
      }

      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    });

    // ポインターアップ (短クリック配置 / 短クリック削除 / ドラッグ終了 & 45度吸着)
    window.addEventListener('pointerup', (e) => {
      if (e.button === 0) {
        this.leftMouseDown = false;
        // ドラッグしていない「短クリック」かつ「編集モード」なら配置処理を発火
        if (!this.hasLeftDragged && this.isEditMode && this.selectedTarget) {
          const { x, y, z, normal } = this.selectedTarget;
          this.handlePlacement(x, y, z, normal);
        }
        this.hasLeftDragged = false;
      } else if (e.button === 2) {
        this.rightMouseDown = false;
        this.cameraSys.snapToNearest45();

        // ドラッグしていない「短クリック」かつ「編集モード」なら削除処理を発火
        if (!this.hasRightDragged && this.isEditMode && this.selectedTarget) {
          const { x, y, z, normal } = this.selectedTarget;
          this.handleRemoval(x, y, z, normal);
        }
        this.hasRightDragged = false;
      }
    });

    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // --- 配置処理 (単体 / ブラシ / スタンプ) ---
  private handlePlacement(x: number, y: number, z: number, normal: THREE.Vector3): void {
    if (this.currentTool === 'stamp') {
      const originX = x + normal.x;
      const originY = y + normal.y;
      const originZ = z + normal.z;
      const stampVoxels = this.getStampVoxels(this.selectedStamp, originX, originY, originZ);

      if (this.world.addVoxelsBatch(stampVoxels)) {
        this.avatar.triggerBuildingAnimation();
        this.sounds.playPlace();
        stampVoxels.forEach((v) => {
          this.network.sendPlaceVoxel(v.x, v.y, v.z, v.type);
        });
        this.network.sendPlayerAction('build', originX, originY, originZ);
        this.recordPlayerAction('build', originX, originZ);
      }
      return;
    }

    const voxelsToPlace: Array<{ x: number; y: number; z: number; type: VoxelType }> = [];
    const baseNx = x + normal.x;
    const baseNy = y + normal.y;
    const baseNz = z + normal.z;

    const r = Math.floor(this.brushSize / 2);
    for (let u = -r; u <= r; u++) {
      for (let v = -r; v <= r; v++) {
        let px = baseNx;
        let py = baseNy;
        let pz = baseNz;

        if (Math.abs(normal.y) > 0.5) {
          px += u;
          pz += v;
        } else if (Math.abs(normal.x) > 0.5) {
          py += u;
          pz += v;
        } else {
          px += u;
          py += v;
        }
        voxelsToPlace.push({ x: px, y: py, z: pz, type: this.selectedVoxelType });
      }
    }

    if (this.world.addVoxelsBatch(voxelsToPlace)) {
      this.avatar.triggerBuildingAnimation();
      this.sounds.playPlace();
      voxelsToPlace.forEach((v) => {
        this.network.sendPlaceVoxel(v.x, v.y, v.z, v.type);
      });
      this.network.sendPlayerAction('build', baseNx, baseNy, baseNz);
      this.recordPlayerAction('build', baseNx, baseNz);
    }
  }

  // --- 削除処理 (単体 / ブラシ) ---
  private handleRemoval(x: number, y: number, z: number, normal: THREE.Vector3): void {
    const coordsToRemove: Array<{ x: number; y: number; z: number }> = [];
    const r = Math.floor(this.brushSize / 2);

    for (let u = -r; u <= r; u++) {
      for (let v = -r; v <= r; v++) {
        let px = x;
        let py = y;
        let pz = z;

        if (Math.abs(normal.y) > 0.5) {
          px += u;
          pz += v;
        } else if (Math.abs(normal.x) > 0.5) {
          py += u;
          pz += v;
        } else {
          px += u;
          py += v;
        }
        coordsToRemove.push({ x: px, y: py, z: pz });
      }
    }

    const mainType = this.world.getVoxelType(x, y, z);
    if (this.world.removeVoxelsBatch(coordsToRemove)) {
      this.avatar.triggerMiningAnimation();
      this.sounds.playMine();

      const color = mainType ? this.world.getVoxelColor(mainType) : new THREE.Color(0x888888);
      coordsToRemove.forEach((c) => {
        this.particles.spawnExplosion(c.x, c.y, c.z, color);
        this.network.sendDestroyVoxel(c.x, c.y, c.z);
      });
      this.network.sendPlayerAction('mine', x, y, z);
      this.recordPlayerAction('mine', x, z);
    }
  }

  // --- 建築スタンプ プリセット定義 ---
  private getStampVoxels(stamp: string, ox: number, oy: number, oz: number): Array<{ x: number; y: number; z: number; type: VoxelType }> {
    const list: Array<{ x: number; y: number; z: number; type: VoxelType }> = [];

    if (stamp === 'tree') {
      for (let h = 0; h < 3; h++) {
        list.push({ x: ox, y: oy + h, z: oz, type: 'wood' });
      }
      for (let lx = -1; lx <= 1; lx++) {
        for (let lz = -1; lz <= 1; lz++) {
          list.push({ x: ox + lx, y: oy + 3, z: oz + lz, type: 'leaves' });
        }
      }
      list.push({ x: ox, y: oy + 4, z: oz, type: 'leaves' });
    } else if (stamp === 'gazebo') {
      const corners = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
      corners.forEach(([cx, cz]) => {
        for (let h = 0; h < 3; h++) {
          list.push({ x: ox + cx, y: oy + h, z: oz + cz, type: 'wood' });
        }
      });
      for (let rx = -2; rx <= 2; rx++) {
        for (let rz = -2; rz <= 2; rz++) {
          list.push({ x: ox + rx, y: oy + 3, z: oz + rz, type: 'plank' });
        }
      }
      list.push({ x: ox, y: oy, z: oz, type: 'stone' });
    } else if (stamp === 'wall') {
      for (let w = -2; w <= 1; w++) {
        for (let h = 0; h < 2; h++) {
          list.push({ x: ox + w, y: oy + h, z: oz, type: 'stone' });
        }
      }
    } else if (stamp === 'stairs') {
      for (let s = 0; s < 3; s++) {
        for (let w = -1; w <= 1; w++) {
          for (let y = 0; y <= s; y++) {
            list.push({ x: ox + w, y: oy + y, z: oz - s, type: 'plank' });
          }
        }
      }
    }

    return list;
  }

  // プレイヤーのアクションを記録（オフライン自律AI用）
  private recordPlayerAction(action: 'mine' | 'build', x: number, z: number): void {
    this.lastPlayerActionTime = performance.now();
    this.lastPlayerActionPos.set(x, 0, z);
  }

  // ピコ自律AIルーチン (オフライン時またはサーバー更新途絶時のフェイルセーフ)
  private updateLocalNPCAI(delta: number): void {
    this.localNpcTimer += delta;

    const now = performance.now();
    const isPlayerActive = (now - this.lastPlayerActionTime) < 9000;
    const distToPlayer = Math.hypot(
      this.npcRenderer.group.position.x - this.avatar.position.x,
      this.npcRenderer.group.position.z - this.avatar.position.z
    );

    const nameEl = document.getElementById('npc-name');
    const goalEl = document.getElementById('npc-goal');
    const taskEl = document.getElementById('npc-task');
    const msgEl = document.getElementById('npc-message');

    if (nameEl) nameEl.innerText = 'お手伝いピコ';

    // プレイヤーが大きく離れた場合 (9m以上) は、タイマーに関係なく追従を開始
    if (distToPlayer > 9.0) {
      if (this.localNpcTimer >= 2.5) {
        this.localNpcTimer = 0;
        this.localNpcNextDecisionTime = 3.5;

        const followAngle = Math.random() * Math.PI * 2;
        const targetX = this.avatar.position.x + Math.cos(followAngle) * 3.0;
        const targetZ = this.avatar.position.z + Math.sin(followAngle) * 3.0;
        this.npcRenderer.targetPos.set(targetX, 0, targetZ);

        const catchupMessages = [
          '待ってくださ〜い！ついて行きます！',
          'トコトコ…！一緒にいきましょう！',
          'どこ行くんですか〜？ピコも行きます！'
        ];
        const msg = catchupMessages[Math.floor(Math.random() * catchupMessages.length)];
        this.npcRenderer.updateSpeechBubble(msg);

        if (goalEl) goalEl.innerText = '目標: プレイヤーへ追従';
        if (taskEl) taskEl.innerText = 'タスク: プレイヤーのそばへ移動中';
        if (msgEl && msgEl.innerText !== `「${msg}」`) {
          msgEl.innerText = `「${msg}」`;
        }
      }
      return;
    }

    // まだ決定インターバルに達していない場合はその場の行動を継続
    if (this.localNpcTimer < this.localNpcNextDecisionTime) return;
    this.localNpcTimer = 0;

    // 現在の目標地点までの残り距離
    const distToTarget = Math.hypot(
      this.npcRenderer.targetPos.x - this.npcRenderer.group.position.x,
      this.npcRenderer.targetPos.z - this.npcRenderer.group.position.z
    );

    // まだ移動中の場合は、次の目標を設定せず歩ききるのを待つ (せわしなさを防止)
    if (distToTarget > 0.4) {
      this.localNpcNextDecisionTime = 2.0;
      return;
    }

    if (isPlayerActive) {
      // プレイヤーが作業中の時は、作業位置のそばで温かく見守る (次回決定まで4〜5秒留まる)
      this.localNpcNextDecisionTime = 4.0 + Math.random() * 2.0;
      const ox = (Math.random() - 0.5) * 2.5;
      const oz = (Math.random() - 0.5) * 2.5;
      this.npcRenderer.targetPos.set(
        this.lastPlayerActionPos.x + (Math.abs(ox) < 1.2 ? 1.5 : ox),
        0,
        this.lastPlayerActionPos.z + (Math.abs(oz) < 1.2 ? 1.5 : oz)
      );

      const cheeringMessages = [
        'その作業、お手伝いしますよ！',
        'ナイスブロック！いい調子ですね！',
        '次はどんな建物を作るのかな？',
        'ここにブロックを置くと綺麗かも！'
      ];
      const msg = cheeringMessages[Math.floor(Math.random() * cheeringMessages.length)];
      this.npcRenderer.updateSpeechBubble(msg);

      if (goalEl) goalEl.innerText = '目標: プレイヤーの作業支援';
      if (taskEl) taskEl.innerText = 'タスク: 建築・採掘アシスト中';
      if (msgEl && msgEl.innerText !== `「${msg}」`) {
        msgEl.innerText = `「${msg}」`;
      }
    } else {
      // 平常時: 5〜7秒に1回、プレイヤーの周囲（半径2.5〜4.5m）をゆったりお散歩＆見回り
      this.localNpcNextDecisionTime = 5.0 + Math.random() * 2.5;
      this.localNpcAngle += 0.6 + Math.random() * 0.5;
      const radius = 2.5 + Math.random() * 2.0;
      const targetX = this.avatar.position.x + Math.cos(this.localNpcAngle) * radius;
      const targetZ = this.avatar.position.z + Math.sin(this.localNpcAngle) * radius;
      this.npcRenderer.targetPos.set(targetX, 0, targetZ);

      const idleMessages = [
        '村の見回り中です！平和ですね〜',
        '何か手伝えることがあったら呼んでね！',
        '今日もいいお天気ですね〜',
        'トコトコ…異常なしです！',
        'ふぅ、ちょっと一休み…♪'
      ];
      const msg = idleMessages[Math.floor(Math.random() * idleMessages.length)];
      this.npcRenderer.updateSpeechBubble(msg);

      if (goalEl) goalEl.innerText = '目標: 村のパトロール';
      if (taskEl) taskEl.innerText = 'タスク: 集落の周回チェック';
      if (msgEl && msgEl.innerText !== `「${msg}」`) {
        msgEl.innerText = `「${msg}」`;
      }
    }
  }

  // --- 編集モード開閉トグル ---
  private toggleEditMode(): void {
    this.isEditMode = !this.isEditMode;
    this.sounds.playSelect();
    document.body.classList.toggle('drawer-open', this.isEditMode);

    const drawer = document.getElementById('edit-drawer');
    const toggleBtn = document.getElementById('btn-toggle-edit');
    const toggleText = document.getElementById('edit-btn-text');
    const toggleIcon = document.getElementById('edit-btn-icon');

    // 操作ガイド & 土地パレットの出し分け切り替え
    const guidePlay = document.getElementById('guide-play');
    const guideEdit = document.getElementById('guide-edit');
    const quickPaletteBar = document.querySelector<HTMLElement>('.bottom-center-bar');

    if (this.isEditMode) {
      drawer?.classList.add('open');
      toggleBtn?.classList.add('active');
      if (toggleText) toggleText.innerText = '閉じる (E)';
      if (toggleIcon) toggleIcon.innerText = '✕';
      if (guidePlay) guidePlay.style.display = 'none';
      if (guideEdit) guideEdit.style.display = 'block';
      if (quickPaletteBar) quickPaletteBar.style.display = 'flex';
      this.updateStatus('🛠️ 編集モードON: 左クリックで配置 / 右クリックで削除');
    } else {
      drawer?.classList.remove('open');
      toggleBtn?.classList.remove('active');
      if (toggleText) toggleText.innerText = 'ワールド編集 (E)';
      if (toggleIcon) toggleIcon.innerText = '🛠️';
      if (guidePlay) guidePlay.style.display = 'block';
      if (guideEdit) guideEdit.style.display = 'none';
      if (quickPaletteBar) quickPaletteBar.style.display = 'none';
      this.cursorMesh.visible = false;
      this.ghostGroup.visible = false;
      this.updateStatus('🟢 散策モード: WASDで移動 / Eキーで編集モード');
    }
  }

  private setupUIHandlers(): void {
    // 編集モードトグルボタン
    const toggleBtn = document.getElementById('btn-toggle-edit');
    toggleBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleEditMode();
    });

    // 閉じるボタン
    const closeBtn = document.getElementById('btn-close-drawer');
    closeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleEditMode();
    });

    // 自キャラ視点リセットボタン
    const resetCamBtn = document.getElementById('btn-reset-camera');
    resetCamBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cameraSys.resetToAvatar();
      this.sounds.playSelect();
      this.updateStatus('🎯 カメラ視点を自キャラに戻しました');
    });

    // お手伝いピコ視点フォーカスボタン
    const focusPicoBtn = document.getElementById('btn-focus-pico');
    focusPicoBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cameraSys.isFollowingAvatar = false;
      this.cameraSys.targetPosition.copy(this.npcRenderer.group.position);
      this.cameraSys.updateCameraPosition();
      this.sounds.playNotice();
      this.updateStatus('🤖 お手伝いピコにカメラを合わせました（WASDキーで自キャラに戻ります）');
    });

    // ピコ頭上吹き出しのON/OFFトグル
    const picoBubbleToggleBtn = document.getElementById('btn-toggle-pico-bubble');
    picoBubbleToggleBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const newVisible = !this.npcRenderer.isBubbleVisible;
      this.npcRenderer.setBubbleVisible(newVisible);
      if (picoBubbleToggleBtn) {
        picoBubbleToggleBtn.textContent = newVisible ? '💬 ON' : '💬 OFF';
        (picoBubbleToggleBtn as HTMLButtonElement).style.opacity = newVisible ? '1' : '0.45';
      }
      this.sounds.playSelect();
    });

    // ドロワー内のクリック貫通防止
    const drawer = document.getElementById('edit-drawer');
    drawer?.addEventListener('pointerdown', (e) => e.stopPropagation());

    // ツール切り替え
    const toolBtns = document.querySelectorAll('.tool-btn');
    const sectionBrush = document.getElementById('section-brush-size');
    const sectionMaterial = document.getElementById('section-material');
    const sectionStamp = document.getElementById('section-stamp');

    toolBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toolBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const tool = btn.getAttribute('data-tool') as 'place' | 'destroy' | 'stamp';
        this.currentTool = tool;
        this.sounds.playSelect();

        if (tool === 'stamp') {
          if (sectionBrush) sectionBrush.style.display = 'none';
          if (sectionMaterial) sectionMaterial.style.display = 'none';
          if (sectionStamp) sectionStamp.style.display = 'flex';
        } else {
          if (sectionBrush) sectionBrush.style.display = 'flex';
          if (sectionMaterial) sectionMaterial.style.display = 'flex';
          if (sectionStamp) sectionStamp.style.display = 'none';
        }
      });
    });

    // ブラシサイズ切り替え
    const brushBtns = document.querySelectorAll('.brush-btn');
    brushBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        brushBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.brushSize = parseInt(btn.getAttribute('data-size') || '1');
        this.sounds.playSelect();
      });
    });

    // 素材パレット切り替え
    const setupPaletteItem = (el: Element) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const type = el.getAttribute('data-type') as VoxelType;
        if (type) this.selectVoxelType(type);
      });
    };

    document.querySelectorAll('.palette-item').forEach(setupPaletteItem);
    document.querySelectorAll('.quick-slot').forEach(setupPaletteItem);

    // スタンプ選択
    const stampCards = document.querySelectorAll('.stamp-card');
    stampCards.forEach((card) => {
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        stampCards.forEach((c) => c.classList.remove('active'));
        card.classList.add('active');
        this.selectedStamp = (card.getAttribute('data-stamp') || 'tree') as 'tree' | 'gazebo' | 'wall' | 'stairs';
        this.sounds.playSelect();
      });
    });
  }

  private selectVoxelType(type: VoxelType): void {
    if (this.selectedVoxelType === type) return;
    this.selectedVoxelType = type;
    this.sounds.playSelect();

    document.querySelectorAll('.palette-item, .quick-slot').forEach((el) => {
      if (el.getAttribute('data-type') === type) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });
  }

  private setupDragAndDrop(): void {
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (files && files.length > 0 && files[0].name.endsWith('.vrm')) {
        const blobUrl = URL.createObjectURL(files[0]);
        this.updateStatus(`VRMモデル読み込み中: ${files[0].name}...`);
        try {
          const vrm = await this.avatar.loadVRMFromUrl(blobUrl);
          this.onAvatarModelLoaded(vrm, files[0].name);
          this.sounds.playDoorbell();
          this.updateStatus(`✅ VRMモデル適用: ${files[0].name}`);
        } catch (err) {
          console.error('VRM読み込みエラー:', err);
          this.updateStatus(`❌ VRM読み込み失敗: ${files[0].name}`);
        }
      }
    });
  }

  // --- レイキャスト & ゴーストプレビュー更新 ---
  private updateRaycastHover(): void {
    if (!this.isEditMode || this.leftMouseDown || this.rightMouseDown) {
      this.selectedTarget = null;
      this.cursorMesh.visible = false;
      this.ghostGroup.visible = false;
      return;
    }

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

        this.updateGhostPreview(this.selectedTarget);
        return;
      }
    }

    this.selectedTarget = null;
    this.cursorMesh.visible = false;
    this.ghostGroup.visible = false;
  }

  private updateGhostPreview(target: { x: number; y: number; z: number; normal: THREE.Vector3 }): void {
    while (this.ghostGroup.children.length > 0) {
      const child = this.ghostGroup.children[0] as THREE.Mesh;
      this.ghostGroup.remove(child);
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }

    const { x, y, z, normal } = target;
    const boxGeo = new THREE.BoxGeometry(0.99, 0.99, 0.99);

    if (this.currentTool === 'destroy') {
      const r = Math.floor(this.brushSize / 2);
      const redMat = new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.55 });

      for (let u = -r; u <= r; u++) {
        for (let v = -r; v <= r; v++) {
          let px = x;
          let py = y;
          let pz = z;

          if (Math.abs(normal.y) > 0.5) { px += u; pz += v; }
          else if (Math.abs(normal.x) > 0.5) { py += u; pz += v; }
          else { px += u; py += v; }

          const ghost = new THREE.Mesh(boxGeo, redMat);
          ghost.position.set(px, py, pz);
          this.ghostGroup.add(ghost);
        }
      }
    } else if (this.currentTool === 'stamp') {
      const originX = x + normal.x;
      const originY = y + normal.y;
      const originZ = z + normal.z;
      const stampVoxels = this.getStampVoxels(this.selectedStamp, originX, originY, originZ);

      stampVoxels.forEach((v) => {
        const col = this.world.getVoxelColor(v.type);
        const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.6 });
        const ghost = new THREE.Mesh(boxGeo, mat);
        ghost.position.set(v.x, v.y, v.z);
        this.ghostGroup.add(ghost);
      });
    } else {
      const r = Math.floor(this.brushSize / 2);
      const col = this.world.getVoxelColor(this.selectedVoxelType);
      const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.6 });

      const baseNx = x + normal.x;
      const baseNy = y + normal.y;
      const baseNz = z + normal.z;

      for (let u = -r; u <= r; u++) {
        for (let v = -r; v <= r; v++) {
          let px = baseNx;
          let py = baseNy;
          let pz = baseNz;

          if (Math.abs(normal.y) > 0.5) { px += u; pz += v; }
          else if (Math.abs(normal.x) > 0.5) { py += u; pz += v; }
          else { px += u; py += v; }

          const ghost = new THREE.Mesh(boxGeo, mat);
          ghost.position.set(px, py, pz);
          this.ghostGroup.add(ghost);
        }
      }
    }

    this.ghostGroup.visible = true;
  }

  private updateStatus(msg: string): void {
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.innerText = msg;
  }

  private updateNetworkStatus(msg: string, isOnline: boolean): void {
    const badge = document.getElementById('network-badge');
    if (badge) {
      badge.innerText = msg;
      if (isOnline) badge.classList.remove('offline');
      else badge.classList.add('offline');
    }
    this.updatePlayerListUI();
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);

    const delta = Math.min(this.clock.getDelta(), 0.1);

    // 画面基準 WASD 入力
    const screenX = (this.keys['d'] || this.keys['arrowright'] ? 1 : 0) - (this.keys['a'] || this.keys['arrowleft'] ? 1 : 0);
    const screenY = (this.keys['w'] || this.keys['arrowup'] ? 1 : 0) - (this.keys['s'] || this.keys['arrowdown'] ? 1 : 0);

    // キー入力があればアバター追従モードに自動復帰
    if (screenX !== 0 || screenY !== 0) {
      this.cameraSys.resetToAvatar();
    }

    const groundY = this.world.getGroundHeight(this.avatar.position.x, this.avatar.position.z);
    this.avatar.update(delta, { screenX, screenY }, groundY, this.cameraSys);

    if (screenX !== 0 || screenY !== 0) {
      this.network.sendPlayerMove(
        this.avatar.position.x,
        this.avatar.position.y,
        this.avatar.position.z,
        this.avatar.rotationY
      );
    }

    const currentCamZoom = this.cameraSys.camera.zoom;

    this.particles.update(delta);
    this.remotePlayers.forEach((rp) => rp.update(delta, 0.5, currentCamZoom));

    // 自アバターの頭上吹き出し追従とズーム適応・タイマー減衰
    if (this.myBubbleSprite && this.myBubbleSprite.visible) {
      const viewH = window.innerHeight || 800;
      const unitsPerPix = 50 / (currentCamZoom * viewH);
      const isCompact = currentCamZoom < 1.35;
      const targetH = (isCompact ? 46 : 80) * unitsPerPix;

      this.myBubbleSprite.position.set(
        this.avatar.position.x,
        this.avatar.position.y + 1.45 + targetH / 2 + 15 * unitsPerPix,
        this.avatar.position.z
      );

      if (Math.abs(this.myBubbleZoom - currentCamZoom) > 0.04) {
        this.myBubbleZoom = currentCamZoom;
        this.renderMyBubbleContent();
      }

      if (this.myBubbleTimer > 0) {
        this.myBubbleTimer -= delta;
        if (this.myBubbleTimer <= 0) {
          this.myBubbleSprite.visible = false;
        }
      }
    }

    // プロフィールモーダル表示中の座標リアルタイム更新
    if (this.isProfileModalOpen) {
      const coordsEl = document.getElementById('modal-player-coords');
      if (coordsEl) {
        coordsEl.innerText = `X: ${this.avatar.position.x.toFixed(1)}, Y: ${this.avatar.position.y.toFixed(1)}, Z: ${this.avatar.position.z.toFixed(1)}`;
      }
    }

    // サーバー更新途絶時（1.5秒以上）またはオフライン時のローカル自律AI更新
    const now = performance.now();
    if (!this.network.isConnected || (now - this.lastServerNpcUpdateTime) > 1500) {
      this.updateLocalNPCAI(delta);
    }

    const npcGroundY = this.world.getGroundHeight(this.npcRenderer.group.position.x, this.npcRenderer.group.position.z);
    this.npcRenderer.update(delta, npcGroundY, currentCamZoom);

    this.updateRaycastHover();
    this.cameraSys.updateCameraFollow(this.avatar.position);

    this.renderer.render(this.scene, this.cameraSys.camera);
  };
}

// アプリケーション起動
new VoxelVRMApp();
