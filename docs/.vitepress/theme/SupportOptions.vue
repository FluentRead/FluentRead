<script setup lang="ts">
import { withBase } from 'vitepress'
defineProps<{ en?: boolean }>()
</script>

<template>
  <div class="support-options">
    <section id="wechat" class="support-option">
      <span class="support-provider">WeChat Pay</span>
      <h2>{{ en ? 'WeChat' : '微信支付' }}</h2>
      <p>
        {{
          en
            ? 'Scan with WeChat to support the maintainer.'
            : '使用微信扫描赞赏码，支持项目维护。'
        }}
      </p>
      <a
        class="support-code"
        :href="withBase('/support/wechat.jpg')"
        target="_blank"
        rel="noopener noreferrer"
        :aria-label="
          en ? 'Open the original WeChat code' : '打开微信赞赏码原图'
        "
      >
        <img
          :src="withBase('/support/wechat.jpg')"
          width="1152"
          height="1152"
          :alt="en ? 'Thinkstu’s WeChat support code' : 'Thinkstu 的微信赞赏码'"
        />
      </a>
      <a
        class="support-code-link"
        :href="withBase('/support/wechat.jpg')"
        target="_blank"
        rel="noopener noreferrer"
        >{{ en ? 'View original image ↗' : '查看原图 ↗' }}</a
      >
    </section>
    <section id="kofi" class="support-option support-option-kofi">
      <span class="support-provider">Ko-fi</span>
      <h2>{{ en ? 'Support on Ko-fi' : '通过 Ko-fi 赞赏' }}</h2>
      <p>
        {{
          en
            ? 'For international supporters, visit the maintainer’s Ko-fi page.'
            : '海外用户也可以通过 Ko-fi 支持项目维护。'
        }}
      </p>
      <div class="support-account">
        <strong>thinkstu</strong><span>ko-fi.com/thinkstu</span>
      </div>
      <a
        class="support-visit"
        href="https://ko-fi.com/thinkstu"
        target="_blank"
        rel="noopener noreferrer"
        >{{ en ? 'Visit Ko-fi ↗' : '前往 Ko-fi ↗' }}</a
      >
    </section>
  </div>
</template>

<style scoped>
.support-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  margin: 28px 0;
}
.support-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 24px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 18px;
  background: var(--vp-c-bg-soft);
}
.support-provider {
  color: var(--vp-c-text-2);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.03em;
}
.support-option h2 {
  margin: 10px 0 0;
  padding: 0;
  border: 0;
  font-size: 22px;
  line-height: 1.4;
}
.support-option p {
  margin: 10px 0 18px;
  font-size: 14px;
  line-height: 1.7;
}
.support-code {
  display: block;
  position: relative;
  overflow: hidden;
  width: 216px;
  max-width: 100%;
  aspect-ratio: 1;
  align-self: center;
  border-radius: 14px;
  background: white;
}
.support-code img {
  position: absolute;
  width: 198.62%;
  max-width: none;
  height: auto;
  left: -49.14%;
  top: -25%;
}
.support-code-link {
  align-self: center;
  margin-top: 14px;
  font-size: 13px;
}
.support-account {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  align-self: center;
  align-items: center;
  min-height: 150px;
  gap: 12px;
}
.support-account strong {
  font-size: 26px;
  letter-spacing: -0.02em;
}
.support-account span {
  color: var(--vp-c-text-2);
  font-size: 14px;
}
.support-visit {
  display: block;
  width: 100%;
  padding: 11px 16px;
  border-radius: 10px;
  color: white !important;
  background: var(--vp-c-brand-1);
  text-align: center;
  text-decoration: none !important;
  font-size: 14px;
  font-weight: 600;
}
.support-visit:hover {
  background: var(--vp-c-brand-2);
}
@media (max-width: 600px) {
  .support-options {
    grid-template-columns: 1fr;
  }
  .support-account {
    min-height: 110px;
  }
}
</style>
