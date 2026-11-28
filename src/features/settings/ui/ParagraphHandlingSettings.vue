<!--
 * @file src/features/settings/ui/ParagraphHandlingSettings.vue
 * 文件职责：在网页翻译的进阶识别策略中呈现段落级翻译设置，包括参与翻译的最少字符数、免滚动预翻译字符数与长段落换行。
 * 主要内容：把三项段落识别配置绑定到共享 config 对象，数值输入按公共范围函数归一化；说明文案全部走稳定 message key。双语上下顺序已归入外观与界面的译文样式预览旁。
 * 模块边界：本组件只做绑定与取值约束，不自行持久化、不决定候选发现算法，也不渲染网页译文；阈值语义由 core 配置模块统一提供。
 -->
<template>
  <div class="paragraph-handling-settings">
    <SettingsItem :label="t('settings.paragraph.minLength')" :description="t('settings.paragraph.minLengthDescription')">
      <SettingsNumberInput
        v-model="props.config.minTranslationTextLength"
        :aria-label="t('settings.paragraph.minLength')"
        :min="MIN_TRANSLATION_TEXT_LENGTH_MIN"
        :max="MIN_TRANSLATION_TEXT_LENGTH_MAX"
        :step="1"
        @change="changeMinLength"
      />
    </SettingsItem>
    <SettingsItem :label="t('settings.paragraph.eagerCharacters')" :description="t('settings.paragraph.eagerCharactersDescription')">
      <SettingsNumberInput
        v-model="props.config.eagerTranslationCharacters"
        :aria-label="t('settings.paragraph.eagerCharacters')"
        :min="EAGER_TRANSLATION_CHARACTERS_MIN"
        :max="EAGER_TRANSLATION_CHARACTERS_MAX"
        :step="100"
        @change="changeEagerCharacters"
      />
    </SettingsItem>
    <SettingsItem :label="t('settings.paragraph.lineBreak')" :description="t('settings.paragraph.lineBreakDescription')">
      <el-switch v-model="props.config.longParagraphLineBreakEnabled" class="settings-toggle"
        :aria-label="t('settings.paragraph.lineBreak')" />
    </SettingsItem>
  </div>
</template>

<script lang="ts" setup>
import type {Config} from '@/src/core/config/model';
import {
  EAGER_TRANSLATION_CHARACTERS_MAX,
  EAGER_TRANSLATION_CHARACTERS_MIN,
  MIN_TRANSLATION_TEXT_LENGTH_MAX,
  MIN_TRANSLATION_TEXT_LENGTH_MIN,
  normalizeEagerTranslationCharacters,
  normalizeMinTranslationTextLength,
} from '@/src/core/config/pageTranslation';
import {useUiI18n} from '@/src/ui/i18n';
import SettingsItem from './components/SettingsItem.vue';
import SettingsNumberInput from './components/SettingsNumberInput.vue';

const props = defineProps<{config: Config}>();
const {t} = useUiI18n();

const changeMinLength = (value: number | undefined): void => {
  props.config.minTranslationTextLength = normalizeMinTranslationTextLength(value);
};

const changeEagerCharacters = (value: number | undefined): void => {
  props.config.eagerTranslationCharacters = normalizeEagerTranslationCharacters(value);
};
</script>
<style scoped>
.paragraph-handling-settings > :deep(.settings-item) {
  border-top: 1px solid var(--line);
}
</style>
