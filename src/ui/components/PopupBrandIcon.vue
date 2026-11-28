<!--
 * @file src/ui/components/PopupBrandIcon.vue
 * 文件职责：在完整保留 FluentRead 原版官方品牌图标（不改色、不替换、不加滤镜）的前提下，为 11 套工艺 Popup 皮肤叠加趣味边缘装饰（挂件、角标、相框与轻交互），让不同主题更具灵动个性。
 * 主要内容：始终渲染原始 32×32 官方 <img> 图标；默认皮肤不加装饰；其余 11 套皮肤通过独立指针穿透 SVG 图层与 useId() 隔离渐变 ID，在图标外缘叠加液态玻璃星芒、极光星轨、拟物硬件 LED、新粗野漫画贴纸框、赛博 HUD 瞄准角标、复古像素光标、终端闪烁提示符、画报书签角标、樱花花饰、抹茶茶芽与黑金皇冠。
 * 模块边界：纯展示包装组件，不读取配置或存储、不触发网络请求，始终把原始图标完整呈现给用户。
 -->
<template>
  <span class="popup-brand-wrap" :data-brand-skin="skin">
    <img :class="['popup-brand-img', imgClass]" :src="src" alt="" width="32" height="32" />
    <svg
      v-if="skin !== 'default'"
      class="popup-brand-charm"
      :data-brand-charm="skin"
      viewBox="-6 -6 44 44"
      width="44"
      height="44"
      fill="none"
      aria-hidden="true"
    >
      <!-- 1. 液态玻璃：冰蓝透明光环 + 晶莹双星芒 -->
      <template v-if="skin === 'liquid-glass'">
        <defs>
          <linearGradient :id="`${uid}-lg`" x1="-2" y1="-2" x2="34" y2="34" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#ffffff" stop-opacity="0.95" />
            <stop offset="50%" stop-color="#7dd3fc" stop-opacity="0.88" />
            <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.85" />
          </linearGradient>
        </defs>
        <rect x="-1.5" y="-1.5" width="35" height="35" rx="10.5" :stroke="`url(#${uid}-lg)`" stroke-width="1.6" />
        <path class="charm-accent" d="M31 -3.5l1.3 3.2 3.2 1.3-3.2 1.3-1.3 3.2-1.3-3.2-3.2-1.3 3.2-1.3 1.3-3.2Z" fill="#ffffff" stroke="#38bdf8" stroke-width="0.9" stroke-linejoin="round" />
        <path d="M1.5 29l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9Z" fill="#e0f2fe" stroke="#2563eb" stroke-width="0.6" />
      </template>

      <!-- 2. 极光幻彩：环绕星轨光环 + 霓虹星尘 -->
      <template v-else-if="skin === 'aurora'">
        <defs>
          <linearGradient :id="`${uid}-au`" x1="-4" y1="26" x2="36" y2="6" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#06b6d4" />
            <stop offset="50%" stop-color="#a855f7" />
            <stop offset="100%" stop-color="#ec4899" />
          </linearGradient>
        </defs>
        <path d="M-3 21.5C1.5 31 15 35.5 28 29.5c4.5-2.1 7.6-5.2 8.2-8.2" :stroke="`url(#${uid}-au)`" stroke-width="2" stroke-linecap="round" />
        <path d="M-3.5 14C-4 10.5 -1.5 6.8 3.5 4.2" stroke="#c084fc" stroke-opacity="0.75" stroke-width="1.4" stroke-linecap="round" />
        <path class="charm-accent" d="M31.5 -2.5l1.1 2.7 2.7 1.1-2.7 1.1-1.1 2.7-1.1-2.7-2.7-1.1 2.7-1.1 1.1-2.7Z" fill="#fde047" stroke="#7c3aed" stroke-width="0.75" stroke-linejoin="round" />
        <circle cx="-1.5" cy="27" r="2" fill="#38bdf8" stroke="#ffffff" stroke-width="0.8" />
        <circle cx="34" cy="24" r="1.4" fill="#f472b6" />
      </template>

      <!-- 3. 拟物硬件：机械键帽边框 + 右上角发光绿 LED -->
      <template v-else-if="skin === 'tactile'">
        <rect x="-2" y="-2" width="36" height="36" rx="9.5" stroke="#a6a094" stroke-width="1.6" />
        <rect x="-0.8" y="-0.8" width="33.6" height="33.6" rx="8.5" stroke="#ffffff" stroke-opacity="0.55" stroke-width="0.9" />
        <circle cx="31.5" cy="1.5" r="4.2" fill="#23252a" stroke="#c7c2b7" stroke-width="1" />
        <circle class="charm-accent" cx="31.5" cy="1.5" r="2.3" fill="#4ade80" />
        <circle cx="30.8" cy="0.8" r="0.7" fill="#dcfce7" />
      </template>

      <!-- 4. 新粗野波普：漫画粗黑贴纸外框 + 右上闪电徽章 -->
      <template v-else-if="skin === 'brutalist'">
        <rect x="-1.5" y="-1.5" width="35" height="35" rx="9" stroke="#111111" stroke-width="2.2" />
        <g class="charm-accent" transform="translate(26.5 -4.5)">
          <circle cx="4.5" cy="4.5" r="5.2" fill="#ffde38" stroke="#111111" stroke-width="1.6" />
          <path d="M5.4 1.3L2.3 5h2.2l-.7 2.8 3.1-3.7H4.7l.7-2.8Z" fill="#111111" />
        </g>
      </template>

      <!-- 5. 赛博霓虹：电光青 / 洋红 HUD 四角瞄准括弧 -->
      <template v-else-if="skin === 'cyber'">
        <path d="M-2.5 7V-2.5H7" stroke="#00e5ff" stroke-width="2" stroke-linecap="square" />
        <path d="M25 34.5h9.5V25" stroke="#00e5ff" stroke-width="2" stroke-linecap="square" />
        <path d="M25 -2.5h9.5V7" stroke="#ff2a85" stroke-width="2" stroke-linecap="square" />
        <path d="M-2.5 25v9.5H7" stroke="#ff2a85" stroke-width="2" stroke-linecap="square" />
        <rect x="33.5" y="13.5" width="2.2" height="5" fill="#00e5ff" />
      </template>

      <!-- 6. 经典复古桌面：3D 凿刻相框 + 右下角经典像素鼠标指针 -->
      <template v-else-if="skin === 'retro-os'">
        <path d="M-2.5 34.5V-2.5h37" stroke="#ffffff" stroke-width="2" />
        <path d="M34.5 -2.5v37H-2.5" stroke="#5c5b55" stroke-width="2" />
        <path class="charm-accent" d="M25.5 20.5v13l3.1-3.1 2.2 4.3 2.1-1-2.2-4.2 4.3-.1-9.5-8.9Z" fill="#ffffff" stroke="#111111" stroke-width="1.35" stroke-linejoin="round" />
      </template>

      <!-- 7. 极客终端：荧光绿角标 + 右下闪烁 >_ 命令行小徽章 -->
      <template v-else-if="skin === 'terminal'">
        <path d="M-2 5V-2h7M27 -2h7v7M-2 27v7h7" stroke="#22c55e" stroke-opacity="0.85" stroke-width="1.4" />
        <rect x="17" y="21.5" width="18" height="12.5" rx="2.5" fill="#050d08" stroke="#4ade80" stroke-width="1.2" />
        <path d="M20.5 25.2l3 2.6-3 2.6" stroke="#4ade80" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        <rect class="terminal-cursor" x="26.5" y="29.5" width="5" height="1.8" fill="#4ade80" />
      </template>

      <!-- 8. 典藏画报：报刊印版套准角线 + 右上角酒红丝带小书签 -->
      <template v-else-if="skin === 'editorial'">
        <path d="M-2.5 4.5V-2.5h7M-2.5 27.5v7h7M27.5 34.5h7v-7" stroke="#7f1d28" stroke-opacity="0.72" stroke-width="1.2" />
        <path class="charm-accent" d="M24.5 -4h8v12.5l-4-2.8-4 2.8V-4Z" fill="#8f1d2c" stroke="#faf6ee" stroke-width="1.1" stroke-linejoin="round" />
        <circle cx="28.5" cy="0.5" r="1.1" fill="#f3d9a4" />
      </template>

      <!-- 9. 樱雾物语：右上角五瓣粉嫩樱花别针 + 飘落小花瓣 -->
      <template v-else-if="skin === 'sakura'">
        <g class="charm-accent sakura-blossom" transform="translate(29.5 2.5)">
          <circle cx="0" cy="-3.4" r="2.7" fill="#ffd6e7" stroke="#d4356f" stroke-width="0.9" />
          <circle cx="3.2" cy="-1.1" r="2.7" fill="#ffd6e7" stroke="#d4356f" stroke-width="0.9" />
          <circle cx="2" cy="2.8" r="2.7" fill="#ffd6e7" stroke="#d4356f" stroke-width="0.9" />
          <circle cx="-2" cy="2.8" r="2.7" fill="#ffd6e7" stroke="#d4356f" stroke-width="0.9" />
          <circle cx="-3.2" cy="-1.1" r="2.7" fill="#ffd6e7" stroke="#d4356f" stroke-width="0.9" />
          <circle cx="0" cy="0" r="1.7" fill="#f59e0b" />
        </g>
        <path d="M-2.5 26.5c1.8-1.6 4.4-1.4 5.2 0.2-1.8 1.6-4.4 1.4-5.2-0.2Z" fill="#fda4af" stroke="#d4356f" stroke-width="0.7" />
      </template>

      <!-- 10. 宇治手账：暖金手账虚线框 + 右上角鲜嫩双叶茶芽 -->
      <template v-else-if="skin === 'matcha'">
        <rect x="-2" y="-2" width="36" height="36" rx="10" stroke="#c8a85a" stroke-width="1.2" stroke-dasharray="3 2.5" />
        <g class="charm-accent matcha-sprout" transform="translate(27 2)">
          <path d="M0 3.5c0-3 1.4-5.5 3.6-7.2" stroke="#1e4d32" stroke-width="1.3" stroke-linecap="round" />
          <path d="M2.2 -1.2c1.8-3.8 5.2-4.8 7.5-4.3-.7 3.7-3.4 6.2-7.5 4.3Z" fill="#4ade80" stroke="#1e4d32" stroke-width="1.1" stroke-linejoin="round" />
          <path d="M1.2 0.6c-3-1.4-4.5-3.9-4.5-6.2 3.1.2 5.4 2.2 4.5 6.2Z" fill="#86efac" stroke="#1e4d32" stroke-width="1.1" stroke-linejoin="round" />
        </g>
      </template>

      <!-- 11. 黑金典藏：香槟金极细边角 + 右上角 Art Deco 迷你皇冠 -->
      <template v-else-if="skin === 'midnight-gold'">
        <defs>
          <linearGradient :id="`${uid}-mg`" x1="18" y1="-5" x2="36" y2="8" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#fff0c2" />
            <stop offset="55%" stop-color="#e5c372" />
            <stop offset="100%" stop-color="#a87b22" />
          </linearGradient>
        </defs>
        <rect x="-1.5" y="-1.5" width="35" height="35" rx="9.5" :stroke="`url(#${uid}-mg)`" stroke-opacity="0.72" stroke-width="1.1" />
        <g class="charm-accent" transform="translate(27.5 0.5) rotate(16)">
          <path d="M-5.5 3.5L-6.8 -3L-2.5 0.2L0 -4.8L2.5 0.2L6.8 -3L5.5 3.5Z" :fill="`url(#${uid}-mg)`" stroke="#140f05" stroke-width="1" stroke-linejoin="round" />
        </g>
      </template>
    </svg>
  </span>
</template>

<script setup lang="ts">
import {useId} from 'vue';
import type {InterfaceSkin} from '@/src/core/config/interfaceAppearance';

withDefaults(defineProps<{
  skin: InterfaceSkin;
  src: string;
  imgClass?: string;
}>(), {
  imgClass: '',
});

const uid = useId();
</script>

<style scoped>
.popup-brand-wrap {
  position: relative;
  display: inline-flex;
  flex: none;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  transition: transform 180ms var(--fr-ease-out, ease);
}

.popup-brand-img {
  display: block;
  width: 32px;
  height: 32px;
  border-radius: 0;
  box-shadow: none;
  object-fit: contain;
}

.popup-brand-charm {
  position: absolute;
  inset: -6px;
  width: 44px;
  height: 44px;
  pointer-events: none;
  overflow: visible;
}

/* 新粗野波普：保留原版图标，整体做趣味微倾贴纸 + 黄色硬偏移投影 */
.popup-brand-wrap[data-brand-skin="brutalist"] {
  border-radius: 8px;
  box-shadow: 3px 3px 0 #111111;
  transform: rotate(-5deg);
}

.popup-brand-wrap[data-brand-skin="brutalist"]:hover {
  transform: rotate(0deg) scale(1.05);
}

.popup-brand-wrap[data-brand-skin="tactile"]:active {
  transform: translateY(1.5px);
}

.popup-brand-wrap[data-brand-skin="sakura"] .sakura-blossom,
.popup-brand-wrap[data-brand-skin="matcha"] .matcha-sprout {
  transition: transform 220ms var(--fr-ease-out, ease);
  transform-box: fill-box;
  transform-origin: center;
}

.popup-brand-wrap[data-brand-skin="sakura"]:hover .sakura-blossom {
  transform: translate(29.5px, 2.5px) rotate(22deg) scale(1.08);
}

.popup-brand-wrap[data-brand-skin="matcha"]:hover .matcha-sprout {
  transform: translate(27px, 2px) rotate(-10deg) scale(1.06);
}

@keyframes fr-terminal-cursor-blink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0.15; }
}

.popup-brand-wrap[data-brand-skin="terminal"] .terminal-cursor {
  animation: fr-terminal-cursor-blink 1.1s steps(1, end) infinite;
}

@media (prefers-reduced-motion: reduce) {
  .popup-brand-wrap,
  .popup-brand-wrap[data-brand-skin="sakura"] .sakura-blossom,
  .popup-brand-wrap[data-brand-skin="matcha"] .matcha-sprout,
  .popup-brand-wrap[data-brand-skin="terminal"] .terminal-cursor {
    animation: none;
    transition: none;
  }
  .popup-brand-wrap[data-brand-skin="brutalist"]:hover,
  .popup-brand-wrap[data-brand-skin="tactile"]:active {
    transform: none;
  }
}
</style>
