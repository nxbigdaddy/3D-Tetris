/**
 * 渲染层:把内核的状态画成一个能看懂的三维方井。
 *
 * 三维俄罗斯方块最难的不是画出来,而是**让人看懂**:
 * 二维版一眼能看出哪一行快满了,三维版从任何单一视角都看不出来。
 * 所以这里除了画面,还刻意做了三件事:
 *   1. **落地投影(ghost)**:方块最终会落在哪 —— 没有它根本没法瞄;
 *   2. **各层填充率**:交给 HUD 画一列 12 根柱条,补上「看不出哪层快满」这个信息缺口;
 *   3. 井底网格 + 深度雾 + 半透明井壁:给深度感,不然前后左右会糊成一团。
 */

import * as THREE from 'three';

export const COLORS = Object.freeze([
  0x000000, // 0 空
  0x4fc3f7, // 1 天蓝
  0xffb74d, // 2 橙
  0x81c784, // 3 绿
  0xe57373, // 4 红
  0xba68c8, // 5 紫
  0xfff176, // 6 黄
  0x4db6ac, // 7 青
]);

export function createView(canvas, rules) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setClearColor(0x0a0e18, 1);
  renderer.shadowMap.enabled = false;

  const scene = new THREE.Scene();
  // 雾只用来给深处压暗一点,别把井口也糊掉 —— 起点调远、终点调大
  scene.fog = new THREE.Fog(0x0a0e18, 34, 78);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  const target = new THREE.Vector3(0, rules.height * 0.54, 0);
  /**
   * 相机球坐标:可以拖拽转视角 —— 三维游戏必须允许玩家从自己的角度观察。
   *
   * 距离的初值只是个起点,真正的取景由 `fitCamera()` **量出来**:它把井的八个角点投影到 NDC,
   * 超安全区就把相机往后拉。为什么不能手推常数:井的底面从 5×5 改成 10×10、或者视口变成手机竖屏,
   * 需要的距离会差出一大截 —— 手推的系数先后错过两次(桌面端 10×10 顶到 NDC 0.66、
   * 手机竖屏横向溢出到 ±1.08)。量一次就都不会错。
   */
  const DEFAULT_ORBIT = { yaw: 0, pitch: 0.46, distance: Math.max(rules.height * 1.7, 12) };
  const orbit = { ...DEFAULT_ORBIT };

  /**
   * 震屏偏移(由 main 每帧写进来)。只偏移相机位置,注视点不动 —— 看起来才是「屏幕在抖」。
   *
   * 声明必须在第一次 applyOrbit() **之前**:模块初始化时就会调用一次,而 const 有暂时性死区,
   * 放在后面会直接让整个模块加载失败(实测报 "Cannot access 'shakeOffset' before initialization",
   * 打包压缩之后只会看到一句 "Cannot access 'c' before initialization",非常难查)。
   */
  const shakeOffset = new THREE.Vector3();

  function applyOrbit() {
    const cosPitch = Math.cos(orbit.pitch);
    // 安全区:注视线往下移(物体在画面上抬高),同时把相机拉远(整体缩小)
    const aimY = target.y - safeBottom * rules.height * 0.62;
    const distance = orbit.distance * (1 + safeBottom * 1.05);
    camera.position.set(
      target.x + Math.sin(orbit.yaw) * cosPitch * distance + shakeOffset.x,
      aimY + Math.sin(orbit.pitch) * distance + shakeOffset.y,
      target.z + Math.cos(orbit.yaw) * cosPitch * distance + shakeOffset.z,
    );
    camera.lookAt(target.x, aimY, target.z);
  }

  /**
   * 底部安全区比例(#touchPad 的高度 / 视口高度)。
   * 手机上屏幕按键会盖住画面下方 —— 不把井抬高、拉远的话,**最底下几层正好被挡住**,
   * 而那恰恰是你要盯着放方块的地方。桌面端这个值是 0,取景完全不变。
   */
  let safeBottom = 0;
  function setSafeArea(ratio) {
    const next = Math.max(0, Math.min(0.45, Number.isFinite(ratio) ? ratio : 0));
    if (Math.abs(next - safeBottom) < 0.01) return;
    safeBottom = next;
    fitCamera();
  }

  applyOrbit();

  // ---------------- 光照
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x24304a, 1.55));
  const key = new THREE.DirectionalLight(0xffffff, 2.5);
  key.position.set(8, 26, 10);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.6);
  fill.position.set(-9, 6, -8);
  scene.add(fill);

  // ---------------- 井
  const cell = 1;
  const { width, depth, height } = rules;
  const innerW = width * cell;
  const innerD = depth * cell;
  const halfW = innerW / 2;
  const halfD = innerD / 2;

  const well = new THREE.Group();
  scene.add(well);

  // 井底网格:25 格,给「一格一格」的尺度感
  const gridMaterial = new THREE.LineBasicMaterial({ color: 0x54749f, transparent: true, opacity: 0.95 });
  const gridPoints = [];
  for (let i = 0; i <= width; i++) {
    const x = -halfW + i * cell;
    gridPoints.push(x, 0, -halfD, x, 0, halfD);
  }
  for (let i = 0; i <= depth; i++) {
    const z = -halfD + i * cell;
    gridPoints.push(-halfW, 0, z, halfW, 0, z);
  }
  const gridGeometry = new THREE.BufferGeometry();
  gridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(gridPoints, 3));
  well.add(new THREE.LineSegments(gridGeometry, gridMaterial));

  // 半透明井壁:太透看不出边界,太实又挡住里面的方块 —— 0.14 是调出来的
  const wallMaterial = new THREE.MeshBasicMaterial({
    color: 0x7fa2e0, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false,
  });
  const walls = [
    { size: [innerW, height], pos: [0, height / 2, -halfD], rot: [0, 0, 0] },
    { size: [innerW, height], pos: [0, height / 2, halfD], rot: [0, 0, 0] },
    { size: [innerD, height], pos: [-halfW, height / 2, 0], rot: [0, Math.PI / 2, 0] },
    { size: [innerD, height], pos: [halfW, height / 2, 0], rot: [0, Math.PI / 2, 0] },
  ];
  for (const wall of walls) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(wall.size[0], wall.size[1]), wallMaterial);
    mesh.position.set(wall.pos[0], wall.pos[1], wall.pos[2]);
    mesh.rotation.set(wall.rot[0], wall.rot[1], wall.rot[2]);
    well.add(mesh);
  }

  // 井口边框:亮线勾出边界,一眼看清井有多大
  const rimPoints = [];
  const rim = (y) => {
    rimPoints.push(-halfW, y, -halfD, halfW, y, -halfD);
    rimPoints.push(halfW, y, -halfD, halfW, y, halfD);
    rimPoints.push(halfW, y, halfD, -halfW, y, halfD);
    rimPoints.push(-halfW, y, halfD, -halfW, y, -halfD);
  };
  rim(0);
  rim(height);
  for (const [x, z] of [[-halfW, -halfD], [halfW, -halfD], [halfW, halfD], [-halfW, halfD]]) {
    rimPoints.push(x, 0, z, x, height, z);
  }
  const rimGeometry = new THREE.BufferGeometry();
  rimGeometry.setAttribute('position', new THREE.Float32BufferAttribute(rimPoints, 3));
  well.add(new THREE.LineSegments(rimGeometry, new THREE.LineBasicMaterial({ color: 0x7fb0ff, transparent: true, opacity: 0.55 })));

  // ---------------- 方块
  const boxGeometry = new THREE.BoxGeometry(cell * 0.94, cell * 0.94, cell * 0.94);
  const materials = COLORS.map((color) => new THREE.MeshLambertMaterial({ color }));

  /** 井内已固定的方块:用对象池,避免每次锁定都重建网格 */
  const fixedGroup = new THREE.Group();
  scene.add(fixedGroup);
  const fixedPool = [];
  let fixedCount = 0;

  function acquireFixed(index) {
    if (!fixedPool[index]) {
      const mesh = new THREE.Mesh(boxGeometry, materials[1]);
      fixedPool[index] = mesh;
      fixedGroup.add(mesh);
    }
    return fixedPool[index];
  }

  /** 当前下落的方块 */
  const pieceGroup = new THREE.Group();
  scene.add(pieceGroup);
  const pieceMeshes = [];

  /** 落地投影 */
  const ghostGroup = new THREE.Group();
  scene.add(ghostGroup);
  const ghostMeshes = [];
  const ghostMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false,
  });
  const ghostEdgeMaterial = new THREE.LineBasicMaterial({ color: 0xaad4ff, transparent: true, opacity: 0.5 });

  /**
   * 粒子:用 THREE.Points 一次画完一把(一次 draw call)。
   * 颜色/大小/透明度逐粒取自 core/effects.js 的纯数据。
   */
  const MAX_POINTS = 900;
  const particleGeometry = new THREE.BufferGeometry();
  const particlePositions = new Float32Array(MAX_POINTS * 3);
  const particleColors = new Float32Array(MAX_POINTS * 3);
  const particleSizes = new Float32Array(MAX_POINTS);
  particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
  particleGeometry.setAttribute('color', new THREE.BufferAttribute(particleColors, 3));
  particleGeometry.setAttribute('size', new THREE.BufferAttribute(particleSizes, 1));
  const particleMaterial = new THREE.PointsMaterial({
    size: 0.22, vertexColors: true, transparent: true, opacity: 0.95, sizeAttenuation: true,
  });
  const particlePoints = new THREE.Points(particleGeometry, particleMaterial);
  particlePoints.frustumCulled = false;
  scene.add(particlePoints);

  /** 把纯数据粒子列表同步到 Points 上 */
  function syncParticles(list) {
    const count = Math.min(list.length, MAX_POINTS);
    for (let i = 0; i < count; i++) {
      const p = list[i];
      const [wx, wy, wz] = [p.x - width / 2, p.y, p.z - depth / 2];
      particlePositions[i * 3] = wx;
      particlePositions[i * 3 + 1] = wy;
      particlePositions[i * 3 + 2] = wz;
      const color = new THREE.Color(COLORS[p.color % COLORS.length]);
      const fade = Math.max(0, 1 - p.age / p.life);
      particleColors[i * 3] = color.r * fade;
      particleColors[i * 3 + 1] = color.g * fade;
      particleColors[i * 3 + 2] = color.b * fade;
      particleSizes[i] = p.size;
    }
    particleGeometry.setDrawRange(0, count);
    particleGeometry.attributes.position.needsUpdate = true;
    particleGeometry.attributes.color.needsUpdate = true;
  }

  /**
   * 消层时**逐格碎裂**:在被消掉的每一格原地留一块会缩小并淡出的方块。
   *
   * 为什么不是「整层闪一下」:三维里玩家最需要确认的就是「消掉的到底是哪一层」,
   * 整层齐闪只能说明「有东西消了」,逐格碎裂才能把那一层的形状交代清楚。
   * 颜色直接用内核带出来的格子颜色,渲染层不猜。
   */
  const shardGroup = new THREE.Group();
  scene.add(shardGroup);
  const shardPool = [];
  const shards = [];

  function shatterCells(cells) {
    for (const { x, y, z, color } of cells) {
      let mesh = shardPool.find((candidate) => !candidate.visible);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(cell * 0.94, cell * 0.94, cell * 0.94),
          new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 }),
        );
        shardGroup.add(mesh);
        shardPool.push(mesh);
      }
      const [wx, wy, wz] = cellToWorld(x, y, z);
      mesh.position.set(wx, wy, wz);
      mesh.scale.setScalar(1);
      mesh.material.color.setHex(COLORS[color % COLORS.length]);
      mesh.material.opacity = 0.95;
      mesh.visible = true;
      shards.push({ mesh, life: 0, duration: 0.38 });
    }
  }

  function updateShards(dt) {
    for (let i = shards.length - 1; i >= 0; i--) {
      const shard = shards[i];
      shard.life += dt;
      const t = Math.min(1, shard.life / shard.duration);
      shard.mesh.scale.setScalar(Math.max(0.05, 1 - t * 0.85));
      shard.mesh.material.opacity = 0.95 * (1 - t);
      // 往上飘一点,像被炸出去
      shard.mesh.position.y += dt * 1.6;
      if (t >= 1) {
        shard.mesh.visible = false;
        shards.splice(i, 1);
      }
    }
  }

  /** 消层闪光 */
  const flashes = [];

  /** 下一个方块的预览:单独一个小场景,画在右上角 */
  const previewScene = new THREE.Scene();
  const previewCamera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
  previewCamera.position.set(4.2, 4.4, 5.6);
  previewCamera.lookAt(0, 0.4, 0);
  previewScene.add(new THREE.HemisphereLight(0xbcd7ff, 0x1b2436, 1.3));
  const previewKey = new THREE.DirectionalLight(0xffffff, 2.2);
  previewKey.position.set(5, 9, 6);
  previewScene.add(previewKey);
  const previewGroup = new THREE.Group();
  previewScene.add(previewGroup);
  let previewShapeKey = null;

  function cellToWorld(x, y, z) {
    return [
      (x - width / 2 + 0.5) * cell,
      (y + 0.5) * cell,
      (z - depth / 2 + 0.5) * cell,
    ];
  }

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    fitCamera();
  }

  /** 井的八个角点(世界坐标) */
  function wellCorners() {
    const halfX = rules.width / 2;
    const halfZ = rules.depth / 2;
    const corners = [];
    for (const x of [-halfX, halfX]) {
      for (const z of [-halfZ, halfZ]) {
        for (const y of [0, rules.height]) corners.push(new THREE.Vector3(x, y, z));
      }
    }
    return corners;
  }

  /**
   * 量一次井在屏幕上的投影范围,超界就把相机往后拉(最多三轮)。
   * 安全区:横向 ±0.9、顶部 0.62(给 HUD 让位)、底部由 `safeBottom` 决定(给手机屏幕按键让位)。
   */
  function fitCamera() {
    for (let attempt = 0; attempt < 3; attempt++) {
      applyOrbit();
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();

      const v = new THREE.Vector3();
      let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
      for (const corner of wellCorners()) {
        v.copy(corner).project(camera);
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      }

      // 内部余量要比端到端断言的阈值(0.9 / 0.62 / 0.86)**更紧一点**:
      // 拟合是「够用就停」,残留误差可以到 0.3%,内部余量若和断言一样宽,
      // 结果会正好卡在阈值外(实测差 0.0008 就被判失败)。
      const marginX = 0.88;
      const marginTop = 0.6;
      const marginBottom = 0.84 - safeBottom * 0.75;
      const scale = Math.max(
        Math.abs(minX) / marginX,
        Math.abs(maxX) / marginX,
        maxY / marginTop,
        Math.abs(minY) / marginBottom,
        1,
      );
      if (scale <= 1.003) return;
      orbit.distance = Math.min(60, orbit.distance * scale);
      // 记录成「默认机位」,这样「视角复位」回到的是拟合之后的位置,而不是一个会被裁掉的初值
      DEFAULT_ORBIT.distance = orbit.distance;
    }
  }

  /** 按内核状态刷新整个画面 */
  function sync(game, options = {}) {
    const { board } = game;

    // 已固定的方块
    fixedCount = 0;
    for (let y = 0; y < board.height; y++) {
      for (let z = 0; z < board.depth; z++) {
        for (let x = 0; x < board.width; x++) {
          const value = board.cells[(y * board.depth + z) * board.width + x];
          if (value === 0) continue;
          const mesh = acquireFixed(fixedCount++);
          const [wx, wy, wz] = cellToWorld(x, y, z);
          mesh.position.set(wx, wy, wz);
          mesh.material = materials[value % materials.length];
          mesh.visible = true;
        }
      }
    }
    for (let i = fixedCount; i < fixedPool.length; i++) fixedPool[i].visible = false;

    // 当前方块
    const cells = game.piece?.cells ?? [];
    while (pieceMeshes.length < cells.length) {
      const mesh = new THREE.Mesh(boxGeometry, materials[1]);
      pieceGroup.add(mesh);
      pieceMeshes.push(mesh);
    }
    pieceMeshes.forEach((mesh, i) => {
      if (i >= cells.length) { mesh.visible = false; return; }
      const [x, y, z] = cells[i];
      const [wx, wy, wz] = cellToWorld(x, y, z);
      mesh.position.set(wx, wy, wz);
      mesh.material = materials[(game.piece.color ?? 1) % materials.length];
      mesh.visible = true;
    });

    // 落地投影
    const ghost = options.ghost ?? null;
    while (ghostMeshes.length < (ghost?.length ?? 0)) {
      const mesh = new THREE.Mesh(boxGeometry, ghostMaterial);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(boxGeometry), ghostEdgeMaterial);
      mesh.add(edges);
      ghostGroup.add(mesh);
      ghostMeshes.push(mesh);
    }
    ghostMeshes.forEach((mesh, i) => {
      if (!ghost || i >= ghost.length) { mesh.visible = false; return; }
      const [x, y, z] = ghost[i];
      const [wx, wy, wz] = cellToWorld(x, y, z);
      // 投影往下压一点点,避免和方块本体重叠闪烁
      mesh.position.set(wx, wy - 0.06, wz);
      mesh.visible = true;
    });

    updatePreview(game);
  }

  function updatePreview(game) {
    const shape = game.rules.pieces.find((p) => p.id === game.nextId);
    const key = shape ? shape.id : null;
    if (key === previewShapeKey) return;
    previewShapeKey = key;
    while (previewGroup.children.length > 0) {
      const child = previewGroup.children.pop();
      child.geometry?.dispose?.();
    }
    if (!shape) return;

    // 预览方块居中摆放
    const cells = shape.cells;
    const maxX = Math.max(...cells.map((c) => c[0]));
    const maxY = Math.max(...cells.map((c) => c[1]));
    const maxZ = Math.max(...cells.map((c) => c[2]));
    const offset = [(maxX + 1) / 2, (maxY + 1) / 2, (maxZ + 1) / 2];
    for (const [x, y, z] of cells) {
      const mesh = new THREE.Mesh(boxGeometry, materials[1]);
      mesh.position.set(x - offset[0] + 0.5, y - offset[1] + 0.5, z - offset[2] + 0.5);
      previewGroup.add(mesh);
    }
  }

  /** 消层时的闪光:在被消的层上放一块会淡出的亮面 */
  function flashLayers(layers) {
    for (const y of layers) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(innerW, innerD),
        new THREE.MeshBasicMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.85, depthWrite: false }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(0, (y + 0.5) * cell, 0);
      scene.add(mesh);
      flashes.push({ mesh, life: 0, duration: 0.45 });
    }
  }

  function updateEffects(dt) {
    updateShards(dt);
    for (let i = flashes.length - 1; i >= 0; i--) {
      const flash = flashes[i];
      flash.life += dt;
      const t = flash.life / flash.duration;
      flash.mesh.material.opacity = Math.max(0, 0.85 * (1 - t));
      flash.mesh.scale.setScalar(1 + t * 0.06);
      if (t >= 1) {
        scene.remove(flash.mesh);
        flash.mesh.geometry.dispose();
        flash.mesh.material.dispose();
        flashes.splice(i, 1);
      }
    }
  }

  /** 相机绕井旋转(鼠标拖拽 / 触摸拖动) */
  function orbitBy(deltaYaw, deltaPitch) {
    orbit.yaw += deltaYaw;
    orbit.pitch = Math.max(-0.15, Math.min(1.45, orbit.pitch + deltaPitch));
    applyOrbit();
  }

  /** 视角复位到默认机位(和初始完全一致 —— 所以默认值只写一份) */
  function resetCamera() {
    Object.assign(orbit, DEFAULT_ORBIT);
    applyOrbit();
  }

  function zoomBy(factor) {
    orbit.distance = Math.max(10, Math.min(48, orbit.distance * factor));
    applyOrbit();
  }

  function render(game, options = {}) {
    if (options.shake) shakeOffset.set(options.shake.x, options.shake.y, options.shake.z);
    else shakeOffset.set(0, 0, 0);
    if (options.shake) applyOrbit();
    sync(game, options);
    if (options.particles) syncParticles(options.particles);
    renderer.setViewport(0, 0, canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
    renderer.render(scene, camera);

    // 右上角画下一个方块
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    const size = Math.min(160, Math.round(Math.min(w, h) * 0.22));
    const margin = 16;
    previewCamera.aspect = 1;
    previewCamera.updateProjectionMatrix();
    // 视口与裁剪框必须一致。第一版把裁剪框写成了 w - size - size,预览被裁到屏幕外
    // (现象是「HUD 写着下一个方块,画面上却看不到它」)。
    const px = w - size - margin;
    const py = h - size - margin;
    renderer.setViewport(px, py, size, size);
    renderer.setScissor(px, py, size, size);
    renderer.setScissorTest(true);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(previewScene, previewCamera);
    renderer.setScissorTest(false);
    renderer.autoClear = true;
  }

  resize();

  return {
    renderer,
    scene,
    camera,
    resize,
    render,
    orbitBy,
    zoomBy,
    resetCamera,
    setSafeArea,
    wellNDC: () => {
      const v = new THREE.Vector3();
      let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
      for (const corner of wellCorners()) {
        v.copy(corner).project(camera);
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      }
      return { minX, maxX, minY, maxY };
    },
    flashLayers,
    shatterCells,
    shardCount: () => shards.length,
    updateEffects,
    get orbit() { return orbit; },
  };
}
