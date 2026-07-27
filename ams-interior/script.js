import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';

const canvas = document.querySelector('#scene');
const wrapper = document.querySelector('.scene-wrap');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
renderer.setSize(wrapper.clientWidth, wrapper.clientHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xd7cebf, 6.5, 15);

const camera = new THREE.PerspectiveCamera(34, wrapper.clientWidth / wrapper.clientHeight, 0.1, 100);
camera.position.set(0.2, 2.7, 8.2);

const ambient = new THREE.HemisphereLight(0xfff7e8, 0x655d50, 2.6);
scene.add(ambient);

const key = new THREE.DirectionalLight(0xffe7c4, 5.5);
key.position.set(-4, 7, 4);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
scene.add(key);

const fill = new THREE.PointLight(0xb9c7aa, 18, 12, 2);
fill.position.set(4, 3, 1);
scene.add(fill);

const group = new THREE.Group();
scene.add(group);

const stone = new THREE.MeshStandardMaterial({ color: 0xc8b59d, roughness: 0.82, metalness: 0.02 });
const plaster = new THREE.MeshStandardMaterial({ color: 0xe8ded0, roughness: 0.92 });
const oak = new THREE.MeshStandardMaterial({ color: 0x8a6248, roughness: 0.72 });
const fabric = new THREE.MeshStandardMaterial({ color: 0x6e7569, roughness: 0.95 });
const dark = new THREE.MeshStandardMaterial({ color: 0x292a25, roughness: 0.7 });

function mesh(geometry, material, position, rotation = [0, 0, 0]) {
  const item = new THREE.Mesh(geometry, material);
  item.position.set(...position);
  item.rotation.set(...rotation);
  item.castShadow = true;
  item.receiveShadow = true;
  group.add(item);
  return item;
}

mesh(new THREE.BoxGeometry(7.2, 0.16, 5.4), plaster, [0, -1.55, 0]);
mesh(new THREE.BoxGeometry(0.15, 4.8, 5.4), plaster, [-3.52, 0.75, 0]);
mesh(new THREE.BoxGeometry(7.2, 4.8, 0.15), plaster, [0, 0.75, -2.62]);

const archShape = new THREE.Shape();
archShape.moveTo(-1.15, -1.5);
archShape.lineTo(-1.15, 0.15);
archShape.absarc(0, 0.15, 1.15, Math.PI, 0, false);
archShape.lineTo(1.15, -1.5);
const arch = mesh(new THREE.ExtrudeGeometry(archShape, { depth: 0.18, bevelEnabled: false }), stone, [1.7, -0.05, -2.5]);
arch.rotation.y = Math.PI;

mesh(new THREE.BoxGeometry(3.4, 0.48, 1.15), fabric, [-0.8, -0.75, -0.6]);
mesh(new THREE.BoxGeometry(3.4, 0.95, 0.34), fabric, [-0.8, -0.1, -1.0], [-0.12, 0, 0]);
mesh(new THREE.BoxGeometry(0.34, 0.82, 1.1), fabric, [-2.35, -0.45, -0.58]);
mesh(new THREE.BoxGeometry(0.34, 0.82, 1.1), fabric, [0.75, -0.45, -0.58]);

const tableTop = mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.13, 64), stone, [1.55, -0.65, 0.75]);
tableTop.rotation.z = Math.PI / 2;
mesh(new THREE.CylinderGeometry(0.18, 0.28, 0.85, 32), oak, [1.55, -1.07, 0.75]);

mesh(new THREE.BoxGeometry(1.25, 0.12, 0.75), oak, [-1.95, 0.35, -2.35]);
mesh(new THREE.BoxGeometry(0.12, 1.35, 0.12), dark, [-2.45, -0.28, -2.35]);
mesh(new THREE.BoxGeometry(0.12, 1.35, 0.12), dark, [-1.45, -0.28, -2.35]);

const vase = mesh(new THREE.CylinderGeometry(0.18, 0.28, 0.75, 32), stone, [-2.0, 0.78, -2.25]);
vase.scale.x = 0.82;

for (let i = 0; i < 6; i++) {
  const stem = mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.0 + Math.random() * 0.4, 8), dark, [-2 + (Math.random() - 0.5) * 0.16, 1.55, -2.24], [0, 0, (Math.random() - 0.5) * 0.34]);
  stem.castShadow = false;
}

const ring = mesh(new THREE.TorusGeometry(0.48, 0.055, 18, 80), oak, [1.85, 1.45, -2.42]);
ring.rotation.y = 0.2;

const rug = mesh(new THREE.CircleGeometry(2.0, 80), new THREE.MeshStandardMaterial({ color: 0xb6a58f, roughness: 1 }), [0.15, -1.45, 0.05], [-Math.PI / 2, 0, 0]);
rug.scale.y = 0.68;

const pointer = { x: 0, y: 0 };
wrapper.addEventListener('pointermove', (event) => {
  const rect = wrapper.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
  pointer.y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
});
wrapper.addEventListener('pointerleave', () => { pointer.x = 0; pointer.y = 0; });

const clock = new THREE.Clock();
function animate() {
  const t = clock.getElapsedTime();
  const targetX = reduceMotion ? 0 : pointer.x * 0.16;
  const targetY = reduceMotion ? 0 : pointer.y * 0.08;
  group.rotation.y += (targetX - group.rotation.y) * 0.035;
  group.rotation.x += (-targetY - group.rotation.x) * 0.035;
  if (!reduceMotion) group.position.y = Math.sin(t * 0.45) * 0.025;
  camera.position.x += ((pointer.x * 0.28) - camera.position.x) * 0.025;
  camera.lookAt(0, -0.05, -0.25);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();

function resize() {
  const width = wrapper.clientWidth;
  const height = wrapper.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) entry.target.classList.add('is-visible');
  });
}, { threshold: 0.12 });

document.querySelectorAll('.intro, .project, .process-list article').forEach((el) => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(24px)';
  el.style.transition = 'opacity .8s ease, transform .8s ease';
  observer.observe(el);
});

const style = document.createElement('style');
style.textContent = '.is-visible{opacity:1!important;transform:translateY(0)!important}';
document.head.appendChild(style);
